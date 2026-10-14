'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
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
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', etag: true }));

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
  if (!u || u.disabled || !verifyPassword(password, u.salt, u.password_hash))
    return res.status(401).json({ error:'Username or password is incorrect.' });
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
  res.json({ users:users.map(u=>({...u,online:online.has(u.id)})) });
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
  res.json({ users:db.prepare('SELECT id,username,role,disabled,created_at AS createdAt FROM users ORDER BY created_at DESC LIMIT 500').all() });
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
    deliver(user.id,payload); if (recipientId !== user.id) deliver(recipientId,payload);
  } else {
    for (const set of online.values()) for (const client of set) send(client,payload);
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
    online.get(user.id).add(ws); send(ws,{type:'connected',protocol:'1.0',user:cleanUser(user)}); publishPresence();
    ws.on('message',raw=>handleMessage(user,ws,raw));
    ws.on('close',()=>{ const set=online.get(user.id); if(set){set.delete(ws);if(!set.size)online.delete(user.id);} publishPresence(); });
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
