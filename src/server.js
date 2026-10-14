'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const webpush = require('web-push');
const { openStore, hashPassword, verifyPassword } = require('./store');

const env = process.env;
const host = env.HOST || '127.0.0.1';
const port = Number(env.PORT || 8443);
const dataDir = path.resolve(env.DATA_DIR || './data');
const keyPath = path.resolve(env.TLS_KEY || './certs/server-key.pem');
const certPath = path.resolve(env.TLS_CERT || './certs/server-cert.pem');
const maxMessageLength = Math.min(4000, Math.max(1, Number(env.MAX_MESSAGE_LENGTH || 4000)));
const ttlMs = Math.max(1, Number(env.SESSION_TTL_HOURS || 168)) * 3600000;
const db = openStore(dataDir);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', etag: true }));

// Small in-process abuse guard for credential and account-creation endpoints.
// Uses the direct socket address (not client-controlled X-Forwarded-For).
// For multi-process deployments, replace with a shared store such as Redis.
const authAttempts = new Map();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 12;
function authAbuseGuard(req, res, next) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const key = ip + ':' + req.path;
  let entry = authAttempts.get(key);
  if (!entry || now - entry.startedAt >= AUTH_WINDOW_MS) {
    entry = { startedAt: now, count: 0 };
    authAttempts.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > AUTH_MAX_ATTEMPTS) {
    res.setHeader('Retry-After', String(Math.ceil((AUTH_WINDOW_MS - (now - entry.startedAt)) / 1000)));
    return res.status(429).json({ error: 'Too many attempts. Wait before trying again.' });
  }
  // Bound memory use and opportunistically remove expired buckets.
  if (authAttempts.size > 5000) {
    for (const [bucket, value] of authAttempts) {
      if (now - value.startedAt >= AUTH_WINDOW_MS) authAttempts.delete(bucket);
    }
  }
  next();
}
app.use(['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/admin/bootstrap'], authAbuseGuard);

const online = new Map(); // userId -> Set<WebSocket>
const sessions = db.prepare('SELECT token_hash,user_id,expires_at FROM sessions');
const getUser = db.prepare('SELECT id,username,role,disabled FROM users WHERE id=?');
const findUser = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE');
const audit = db.prepare('INSERT INTO audit(actor_id,action,target,created_at) VALUES(?,?,?,?)');
const nowIso = () => new Date().toISOString();
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
function cleanUser(u) { return { id: u.id, username: u.username, role: u.role }; }
function sessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(tokenHash(token));
  if (!row || row.expires_at < Date.now()) return null;
  const user = getUser.get(row.user_id);
  return user && !user.disabled ? user : null;
}
function bearer(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}
function requireAuth(req,res,next) {
  const user = sessionUser(bearer(req));
  if (!user) return res.status(401).json({ error: 'Sign in again to continue.' });
  req.user = user; next();
}
function requireAdmin(req,res,next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}
function validUsername(s) { return typeof s === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(s); }
function validPassword(s) { return typeof s === 'string' && Buffer.byteLength(s, 'utf8') >= 12 && Buffer.byteLength(s, 'utf8') <= 128; }
function issueSession(user) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(tokenHash(token), user.id, nowIso(), Date.now() + ttlMs);
  return token;
}
function record(actor, action, target = null) { audit.run(actor || null, action, target, nowIso()); }
const vapidPublicKey = env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = env.VAPID_PRIVATE_KEY || '';
const vapidSubject = env.VAPID_SUBJECT || 'mailto:admin@example.invalid';
const pushConfigured = !!(vapidPublicKey && vapidPrivateKey);
if (pushConfigured) webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
function sendPushToUser(userId, notification) {
  if (!pushConfigured) return;
  const subscriptions = db.prepare('SELECT id,subscription_json FROM push_subscriptions WHERE user_id=?').all(userId);
  for (const sub of subscriptions) {
    let parsed;
    try { parsed = JSON.parse(sub.subscription_json); } catch { db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id); continue; }
    webpush.sendNotification(parsed, JSON.stringify({ title: notification.title, body: notification.body, url: '/' }))
      .catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
        else console.error('Web Push delivery failed:', err.statusCode || err.message);
      });
  }
}
function createNotification(userId, kind, title, body) {
  const info = db.prepare('INSERT INTO notifications(user_id,kind,title,body,created_at) VALUES(?,?,?,?,?)')
    .run(userId, kind, String(title).slice(0,100), String(body).slice(0,240), nowIso());
  const item = db.prepare('SELECT id,kind,title,body,created_at AS createdAt,read_at AS readAt FROM notifications WHERE id=?').get(Number(info.lastInsertRowid));
  deliver(userId, { type:'notification.new', notification:item });
  sendPushToUser(userId, item);
  return item;
}

app.get('/api/v1/health', (req,res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true, status: 'healthy', uptimeSeconds: Math.floor(process.uptime()), onlineUsers: online.size, protocol: '1.0' }); }
  catch { res.status(503).json({ ok:false, status:'unhealthy' }); }
});
app.get('/api/v1/protocol', (req,res) => res.json({ name:'SCSP', version:'1.0', transport:'WSS over verified TLS', messageTypes:['public.send','private.send','presence.list','message.new','error'], maxMessageLength }));
app.post('/api/v1/auth/register', (req,res) => {
  if (env.ALLOW_REGISTRATION === 'false') return res.status(403).json({ error:'Registration is closed by the administrator.' });
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error:'Username must be 3–24 letters, digits or underscores.' });
  if (!validPassword(password)) return res.status(400).json({ error:'Password must be 12–128 bytes.' });
  if (findUser.get(username)) return res.status(409).json({ error:'That username is already taken.' });
  const {salt,hash} = hashPassword(password);
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO users(id,username,salt,password_hash,created_at) VALUES(?,?,?,?,?)').run(id, username, salt, hash, nowIso());
    record(id,'account.registered',username);
    const token = issueSession({id});
    return res.status(201).json({ token, user:{id,username,role:'user'} });
  } catch (e) { return res.status(500).json({ error:'Could not create account.' }); }
});
app.post('/api/v1/auth/login', (req,res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 24 || password.length > 128)
    return res.status(400).json({ error:'Enter a valid username and password.' });
  const u = findUser.get(username);
  if (!u || u.disabled || !verifyPassword(password, u.salt, u.password_hash)) {
    record(null, 'auth.login.failed', typeof username === 'string' ? username.slice(0,24) : null);
    return res.status(401).json({ error:'Username or password is incorrect.' });
  }
  const token = issueSession(u); record(u.id,'auth.login');
  res.json({ token, user:cleanUser(u) });
});
app.post('/api/v1/auth/logout', requireAuth, (req,res) => {
  const token = bearer(req); db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
  record(req.user.id,'auth.logout'); res.json({ ok:true });
});
app.get('/api/v1/me', requireAuth, (req,res) => res.json({ user:cleanUser(req.user) }));
app.get('/api/v1/users', requireAuth, (req,res) => {
  const users = db.prepare('SELECT id,username,role FROM users WHERE disabled=0 ORDER BY username COLLATE NOCASE').all();
  res.json({ users:users.map(u=>({...u,online:online.has(u.id)})), total:db.prepare('SELECT count(*) AS n FROM users').get().n, enabled:db.prepare('SELECT count(*) AS n FROM users WHERE disabled=0').get().n, disabled:db.prepare('SELECT count(*) AS n FROM users WHERE disabled=1').get().n });
});
app.get('/api/v1/room/unread', requireAuth, (req,res) => {
  const state = db.prepare('SELECT last_read_public_message_id AS lastRead FROM user_state WHERE user_id=?').get(req.user.id);
  const lastRead = state ? state.lastRead : 0;
  const unread = db.prepare('SELECT count(*) AS n FROM messages WHERE recipient_id IS NULL AND id>? AND sender_id<>?').get(lastRead,req.user.id).n;
  res.json({ unread, lastReadMessageId:lastRead });
});
app.post('/api/v1/room/read', requireAuth, (req,res) => {
  const latest = db.prepare('SELECT coalesce(max(id),0) AS id FROM messages WHERE recipient_id IS NULL').get().id;
  db.prepare('INSERT INTO user_state(user_id,last_read_public_message_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_read_public_message_id=max(last_read_public_message_id,excluded.last_read_public_message_id)').run(req.user.id,latest);
  res.json({ ok:true, unread:0, lastReadMessageId:latest });
});
app.put('/api/v1/device', requireAuth, (req,res) => {
  const d=req.body||{};
  if (d.consent !== true) return res.status(400).json({ error:'Device diagnostics require explicit consent.' });
  if (typeof d.deviceId !== 'string' || !/^[a-f0-9-]{16,64}$/i.test(d.deviceId)) return res.status(400).json({ error:'Invalid device identifier.' });
  const textField=(v,max)=>typeof v==='string'?v.trim().slice(0,max):null;
  const integerField=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max?v:null;
  const numberField=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:null;
  const now=nowIso();
  const vals={
    id:d.deviceId,userId:req.user.id,label:textField(d.label,80)||'This device',
    deviceType:textField(d.deviceType,24)||'unknown',browser:textField(d.browser,80)||'unknown',
    os:textField(d.os,80)||'unknown',screenWidth:integerField(d.screenWidth,0,20000),
    screenHeight:integerField(d.screenHeight,0,20000),timezone:textField(d.timezone,80),
    language:textField(d.language,35),appVersion:textField(d.appVersion,40),
    batteryLevel:integerField(d.batteryLevel,0,100),batteryCharging:typeof d.batteryCharging==='boolean'?(d.batteryCharging?1:0):null,
    locationLat:numberField(d.locationLat,-90,90),locationLng:numberField(d.locationLng,-180,180),
    locationSharedAt:d.locationLat!=null&&d.locationLng!=null?now:null,consentAt:now,lastSeenAt:now,createdAt:now
  };
  db.prepare(`INSERT INTO devices(id,user_id,label,device_type,browser,os,screen_width,screen_height,timezone,language,app_version,battery_level,battery_charging,location_lat,location_lng,location_shared_at,consent_at,last_seen_at,created_at)
    VALUES(@id,@userId,@label,@deviceType,@browser,@os,@screenWidth,@screenHeight,@timezone,@language,@appVersion,@batteryLevel,@batteryCharging,@locationLat,@locationLng,@locationSharedAt,@consentAt,@lastSeenAt,@createdAt)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,label=excluded.label,device_type=excluded.device_type,browser=excluded.browser,os=excluded.os,screen_width=excluded.screen_width,screen_height=excluded.screen_height,timezone=excluded.timezone,language=excluded.language,app_version=excluded.app_version,battery_level=excluded.battery_level,battery_charging=excluded.battery_charging,location_lat=excluded.location_lat,location_lng=excluded.location_lng,location_shared_at=excluded.location_shared_at,consent_at=excluded.consent_at,last_seen_at=excluded.last_seen_at`).run(vals);
  res.json({ ok:true, deviceId:d.deviceId, recordedAt:now });
});
app.delete('/api/v1/device/:id', requireAuth, (req,res) => {
  db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(req.params.id,req.user.id);
  res.json({ ok:true });
});
app.get('/api/v1/admin/devices', requireAuth, requireAdmin, (req,res) => {
  const devices=db.prepare(`SELECT d.id,d.user_id AS userId,u.username,d.label,d.device_type AS deviceType,d.browser,d.os,d.screen_width AS screenWidth,d.screen_height AS screenHeight,d.timezone,d.language,d.app_version AS appVersion,d.battery_level AS batteryLevel,d.battery_charging AS batteryCharging,d.location_lat AS locationLat,d.location_lng AS locationLng,d.location_shared_at AS locationSharedAt,d.consent_at AS consentAt,d.last_seen_at AS lastSeenAt FROM devices d JOIN users u ON u.id=d.user_id WHERE u.disabled=0 ORDER BY d.last_seen_at DESC LIMIT 1000`).all();
  res.json({ devices, total:devices.length, privacy:'Only devices whose users explicitly opted in are listed. IP addresses and precise location are not collected automatically.' });
});
app.get('/api/v1/admin/notifications', requireAuth, requireAdmin, (req,res) => {
  const notifications=db.prepare(`SELECT n.id,n.user_id AS userId,u.username,n.kind,n.title,n.body,n.created_at AS createdAt,n.read_at AS readAt FROM notifications n JOIN users u ON u.id=n.user_id ORDER BY n.id DESC LIMIT 200`).all();
  res.json({ notifications });
});
app.get('/api/v1/notifications', requireAuth, (req,res) => {
  const notifications = db.prepare('SELECT id,kind,title,body,created_at AS createdAt,read_at AS readAt FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const unread = db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).n;
  res.json({ notifications, unread, pushConfigured:!!(vapidPublicKey && vapidPrivateKey) });
});
app.patch('/api/v1/notifications/:id/read', requireAuth, (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error:'Invalid notification id.' });
  db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').run(nowIso(),id,req.user.id);
  res.json({ ok:true, unread:db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).n });
});
app.post('/api/v1/notifications/read-all', requireAuth, (req,res) => {
  db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(nowIso(),req.user.id);
  res.json({ ok:true, unread:0 });
});
app.get('/api/v1/push/public-key', requireAuth, (req,res) => {
  if (!pushConfigured) return res.status(503).json({ error:'Server Web Push keys are not configured.' });
  res.json({ publicKey:vapidPublicKey });
});
app.post('/api/v1/push/subscribe', requireAuth, authAbuseGuard, (req,res) => {
  if (!pushConfigured) return res.status(503).json({ error:'Server Web Push keys are not configured.' });
  const sub = req.body && req.body.subscription;
  let endpoint;
  try { endpoint = new URL(sub && sub.endpoint); } catch { return res.status(400).json({ error:'Invalid push subscription.' }); }
  const host = endpoint.hostname.toLowerCase();
  const allowedPushHost = host === 'fcm.googleapis.com' || host.endsWith('.push.services.mozilla.com') ||
    host === 'updates.push.services.mozilla.com' || host.endsWith('.push.apple.com');
  if (!sub || endpoint.protocol !== 'https:' || !allowedPushHost || sub.endpoint.length > 2048 ||
      !sub.keys || typeof sub.keys.p256dh !== 'string' || sub.keys.p256dh.length > 256 ||
      typeof sub.keys.auth !== 'string' || sub.keys.auth.length > 256)
    return res.status(400).json({ error:'Invalid or unsupported push subscription endpoint.' });
  db.prepare('INSERT INTO push_subscriptions(user_id,endpoint,subscription_json,created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,subscription_json=excluded.subscription_json')
    .run(req.user.id,sub.endpoint,JSON.stringify(sub),nowIso());
  res.json({ ok:true });
});
app.delete('/api/v1/push/subscribe', requireAuth, (req,res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return res.status(400).json({ error:'Invalid push endpoint.' });
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id,endpoint);
  res.json({ ok:true });
});
app.post('/api/v1/admin/notifications', requireAuth, requireAdmin, authAbuseGuard, (req,res) => {
  const { targetUserId, all, title, body } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100 || typeof body !== 'string' || !body.trim() || body.trim().length > 240)
    return res.status(400).json({ error:'Title is required (max 100 characters) and message must be 1–240 characters.' });
  let targets;
  if (all === true) targets = db.prepare('SELECT id FROM users WHERE disabled=0').all().map(u=>u.id);
  else if (typeof targetUserId === 'string' && targetUserId.length <= 64) {
    const target = getUser.get(targetUserId);
    if (!target || target.disabled) return res.status(404).json({ error:'Target user not found or disabled.' });
    targets = [target.id];
  } else return res.status(400).json({ error:'Choose one user or set all=true.' });
  const tx = db.transaction(() => targets.map(id=>createNotification(id,'admin',title.trim(),body.trim())));
  tx();
  record(req.user.id,'admin.notification.send',all===true?'all':targetUserId);
  res.status(201).json({ ok:true, deliveredTo:targets.length });
});
app.get('/api/v1/messages/public', requireAuth, (req,res) => {
  const messages = db.prepare(`SELECT m.id,m.body,m.created_at AS createdAt,u.username AS sender FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.recipient_id IS NULL ORDER BY m.id DESC LIMIT 100`).all().reverse();
  res.json({ messages });
});
app.get('/api/v1/messages/private/:username', requireAuth, (req,res) => {
  const other = findUser.get(req.params.username);
  if (!other || other.disabled) return res.status(404).json({ error:'User not found.' });
  const messages = db.prepare(`SELECT m.id,m.body,m.created_at AS createdAt,u.username AS sender FROM messages m JOIN users u ON u.id=m.sender_id WHERE (m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?) ORDER BY m.id DESC LIMIT 100`)
    .all(req.user.id,other.id,other.id,req.user.id).reverse();
  res.json({ messages });
});
app.get('/api/v1/admin/metrics', requireAuth, requireAdmin, (req,res) => {
  res.json({ uptimeSeconds:Math.floor(process.uptime()), onlineUsers:online.size,
    users:db.prepare('SELECT count(*) n FROM users').get().n,
    messages:db.prepare('SELECT count(*) n FROM messages').get().n,
    activeSessions:db.prepare('SELECT count(*) n FROM sessions WHERE expires_at>?').get(Date.now()).n,
    database:'connected', memoryBytes:process.memoryUsage().rss });
});
app.get('/api/v1/admin/users', requireAuth, requireAdmin, (req,res) => {
  res.json({ users:db.prepare(`SELECT u.id,u.username,u.role,u.disabled,u.created_at AS createdAt,
    (SELECT max(d.last_seen_at) FROM devices d WHERE d.user_id=u.id) AS lastDeviceSeen,
    (SELECT count(*) FROM devices d WHERE d.user_id=u.id) AS registeredDevices
    FROM users u ORDER BY u.created_at DESC LIMIT 500`).all() });
});
app.post('/api/v1/admin/users/:id/disable', requireAuth, requireAdmin, (req,res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error:'You cannot disable your own account.' });
  const tx = db.transaction(() => {
    const result = db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(req.params.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
    record(req.user.id,'admin.user.disable',req.params.id); return result.changes;
  });
  if (!tx()) return res.status(404).json({ error:'User not found.' });
  for (const ws of online.get(req.params.id) || []) ws.close(4003,'Account disabled');
  res.json({ ok:true });
});
app.get('/api/v1/admin/audit', requireAuth, requireAdmin, (req,res) => {
  res.json({ entries:db.prepare('SELECT id,actor_id AS actorId,action,target,created_at AS createdAt FROM audit ORDER BY id DESC LIMIT 200').all() });
});
app.post('/api/v1/admin/bootstrap', (req,res) => {
  const expected = env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expected || Buffer.byteLength(expected) < 24 || req.headers['x-bootstrap-token'] !== expected)
    return res.status(403).json({ error:'Valid bootstrap token required.' });
  const count = db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n;
  if (count) return res.status(409).json({ error:'An administrator already exists.' });
  const { username,password } = req.body || {};
  if (!validUsername(username) || !validPassword(password)) return res.status(400).json({ error:'Use a valid username and a password of at least 12 bytes.' });
  if (findUser.get(username)) return res.status(409).json({ error:'That username is already taken.' });
  const {salt,hash} = hashPassword(password), id=crypto.randomUUID();
  db.prepare("INSERT INTO users(id,username,salt,password_hash,role,created_at) VALUES(?,?,?,?, 'admin', ?)").run(id,username,salt,hash,nowIso());
  record(id,'admin.bootstrap',username); res.status(201).json({ ok:true, message:'Administrator created. Remove ADMIN_BOOTSTRAP_TOKEN from the environment now.' });
});

function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function publishPresence() {
  const users = db.prepare('SELECT id,username FROM users WHERE disabled=0 ORDER BY username').all()
    .map(u=>({id:u.id,username:u.username,online:online.has(u.id)}));
  for (const set of online.values()) for (const ws of set) send(ws,{type:'presence.list',users});
}
function deliver(userId, payload) { for (const ws of online.get(userId) || []) send(ws,payload); }
function handleMessage(user, ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return send(ws,{type:'error',error:'Message must be valid JSON.'}); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send(ws,{type:'error',error:'Invalid message format.'});
  if (msg.type === 'ping') return send(ws,{type:'pong',at:Date.now()});
  if (!['public.send','private.send'].includes(msg.type)) return send(ws,{type:'error',error:'Unsupported message type.'});
  if (typeof msg.body !== 'string' || !msg.body.trim() || msg.body.length > maxMessageLength)
    return send(ws,{type:'error',error:'Message must be 1–'+maxMessageLength+' characters.'});
  let recipientId = null;
  if (msg.type === 'private.send') {
    if (typeof msg.to !== 'string' || msg.to.length > 24) return send(ws,{type:'error',error:'Choose a valid recipient.'});
    const target = findUser.get(msg.to);
    if (!target || target.disabled) return send(ws,{type:'error',error:'Recipient not found.'});
    recipientId = target.id;
  }
  const body = msg.body.trim(), createdAt=nowIso();
  const info = db.prepare('INSERT INTO messages(sender_id,recipient_id,body,created_at) VALUES(?,?,?,?)').run(user.id,recipientId,body,createdAt);
  const payload = {type:'message.new',message:{id:Number(info.lastInsertRowid),sender:user.username,body,createdAt,private:!!recipientId}};
  if (recipientId) {
    deliver(user.id,payload);
    if (recipientId !== user.id) {
      deliver(recipientId,payload);
      createNotification(recipientId,'message','New message from '+user.username,body);
    }
  } else {
    for (const set of online.values()) for (const client of set) send(client,payload);
    // Public-room unread state is tracked by a cursor. Do not create N notification
    // rows or N push requests for every public message: that turns one sender into
    // an O(users) database/push amplifier and makes trivial notification flooding possible.
  }
}
let server;
function start() {
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error('TLS certificate not found. See docs/SETUP.md. Refusing to start without TLS.');
    process.exitCode = 1; return;
  }
  server = https.createServer({ key:fs.readFileSync(keyPath), cert:fs.readFileSync(certPath), minVersion:'TLSv1.2' }, app);
  const wss = new WebSocketServer({ noServer:true, maxPayload:16*1024, perMessageDeflate:false });
  server.on('upgrade',(req,socket,head)=>{
    if (req.url !== '/ws') { socket.destroy(); return; }
    const url = new URL(req.url,'https://localhost');
    const protocol = req.headers['sec-websocket-protocol'];
    const token = typeof protocol === 'string' ? protocol.split(',').map(s=>s.trim()).find(s=>s.startsWith('scsp.'))?.slice(5) : null;
    const user = sessionUser(token);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req,socket,head,ws=>{ ws.user=user; wss.emit('connection',ws,req); });
  });
  wss.on('connection',(ws)=>{
    const user=ws.user;
    if (!online.has(user.id)) online.set(user.id,new Set());
    const set = online.get(user.id);
    // Bound simultaneous sessions per account to reduce connection exhaustion.
    if (set.size >= 4) {
      ws.close(4008, 'Too many active connections');
      if (!set.size) online.delete(user.id);
      return;
    }
    set.add(ws);
    let windowStarted = Date.now(), messagesInWindow = 0;
    ws.on('message',raw=>{
      const now = Date.now();
      if (now - windowStarted >= 10_000) { windowStarted = now; messagesInWindow = 0; }
      messagesInWindow += 1;
      if (messagesInWindow > 40) { ws.close(4008, 'Message rate exceeded'); return; }
      handleMessage(user,ws,raw);
    });
    send(ws,{type:'connected',protocol:'1.0',user:cleanUser(user)}); publishPresence();
    ws.on('close',()=>{ const current=online.get(user.id); if(current){current.delete(ws);if(!current.size)online.delete(user.id);} publishPresence(); });
  });
  const cleanup = setInterval(()=>db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()),3600000);
  cleanup.unref();
  server.listen(port,host,()=>console.log('Secure Chat listening on https://'+host+':'+port));
  const shutdown=()=>{ console.log('Shutting down gracefully…'); for(const set of online.values())for(const ws of set)ws.close(1001,'Server shutting down'); server.close(()=>{db.close();process.exit(0)}); setTimeout(()=>process.exit(1),10000).unref(); };
  process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
  if (process.send) process.on('message', message => { if (message && message.type === 'shutdown') shutdown(); });
}
if (require.main === module) start();
module.exports = { validUsername, validPassword };
