'use strict';
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const selfsigned = require('selfsigned');

let managerWindow, clientWindow, serverProcess = null;
let serverState = 'stopped', serverError = '', localFingerprint = '';
const userData = app.getPath('userData');
const dataDir = path.join(userData, 'data'), certDir = path.join(userData, 'certs'), logDir = path.join(userData, 'logs');
const keyPath = path.join(certDir, 'server-key.pem'), certPath = path.join(certDir, 'server-cert.pem');
const settingsPath = path.join(userData, 'settings.json');
const DEFAULT_SETTINGS = { port: 8443, networkMode: 'local', allowRegistration: true, maxMessageLength: 4000, sessionTtlHours: 168 };
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    const x = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings = {
      port: Number.isInteger(x.port) && x.port >= 1024 && x.port <= 65535 ? x.port : 8443,
      networkMode: x.networkMode === 'lan' ? 'lan' : 'local',
      allowRegistration: x.allowRegistration !== false,
      maxMessageLength: Number.isInteger(x.maxMessageLength) && x.maxMessageLength >= 100 && x.maxMessageLength <= 4000 ? x.maxMessageLength : 4000,
      sessionTtlHours: Number.isInteger(x.sessionTtlHours) && x.sessionTtlHours >= 1 && x.sessionTtlHours <= 720 ? x.sessionTtlHours : 168
    };
  } catch { settings = { ...DEFAULT_SETTINGS }; saveSettings(); }
}
function saveSettings() {
  ensureDirectories();
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}
function lanAddresses() {
  const ips = [];
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
    if (entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) ips.push(entry.address);
  }
  return [...new Set(ips)];
}

function ensureDirectories() { for (const dir of [dataDir, certDir, logDir]) fs.mkdirSync(dir, { recursive: true }); }
async function ensureCertificate() {
  ensureDirectories();
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const generated = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      keySize: 2048, days: 365,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map(ip => ({ type: 7, ip }))] }]
    });
    fs.writeFileSync(keyPath, generated.private, { mode: 0o600 });
    fs.writeFileSync(certPath, generated.cert, { mode: 0o600 });
  }
  localFingerprint = new crypto.X509Certificate(fs.readFileSync(certPath)).fingerprint256.replace(/:/g, '').toLowerCase();
}
function setLocalCertificateTrust() {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const fingerprint = request.certificate && (request.certificate.fingerprint256 || request.certificate.fingerprint)
      ? (request.certificate.fingerprint256 || request.certificate.fingerprint).replace(/:/g, '').toLowerCase() : '';
    if (['localhost', '127.0.0.1'].includes(request.hostname) && fingerprint && fingerprint === localFingerprint) callback(0);
    else callback(-2);
  });
}
function createWindow() {
  managerWindow = new BrowserWindow({
    width: 900, height: 700, minWidth: 640, minHeight: 560, title: 'Secure Chat — Desktop Manager',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  managerWindow.loadFile(path.join(__dirname, 'manager.html'));
  managerWindow.on('closed', () => { managerWindow = null; });
}
function logLine(line) { try { fs.appendFileSync(path.join(logDir, 'server.log'), '[' + new Date().toISOString() + '] ' + line + '\n'); } catch {} }
function status() {
  return { state: serverState, pid: serverProcess ? serverProcess.pid : null,
    localUrl: 'https://127.0.0.1:' + settings.port,
    lanUrls: lanAddresses().map(ip => 'https://' + ip + ':' + settings.port),
    networkMode: settings.networkMode, settings: { ...settings }, certificatePath: certPath,
    certificateFingerprint: new crypto.X509Certificate(fs.readFileSync(certPath)).fingerprint256,
    error: serverError, logPath: path.join(logDir, 'server.log') };
}
function notifyStatus() { if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send('server-status', status()); }
async function startServer() {
  if (serverProcess && !serverProcess.killed) return { ok: true, state: serverState, message: 'Server is already running.' };
  await ensureCertificate();
  serverState = 'starting'; serverError = '';
  const script = path.join(app.getAppPath(), 'src', 'server.js');
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: settings.networkMode === 'lan' ? '0.0.0.0' : '127.0.0.1', PORT: String(settings.port), DATA_DIR: dataDir, TLS_KEY: keyPath, TLS_CERT: certPath, ALLOW_REGISTRATION: settings.allowRegistration ? 'true' : 'false', MAX_MESSAGE_LENGTH: String(settings.maxMessageLength), SESSION_TTL_HOURS: String(settings.sessionTtlHours) };
  delete childEnv.ADMIN_BOOTSTRAP_TOKEN;
  const child = spawn(process.execPath, [script], { cwd: userData, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  serverProcess = child;
  child.stdout.on('data', b => { const s = b.toString(); logLine(s.trimEnd()); if (s.includes('Secure Chat listening')) { serverState = 'running'; notifyStatus(); } });
  child.stderr.on('data', b => { const s = b.toString(); logLine('ERROR ' + s.trimEnd()); serverError = s.trim().slice(-500); notifyStatus(); });
  child.once('error', err => { serverState = 'error'; serverError = err.message; serverProcess = null; notifyStatus(); });
  child.once('exit', (code, signal) => {
    logLine('Server process exited (code=' + code + ', signal=' + signal + ')');
    serverProcess = null;
    serverState = (serverState === 'stopping' || code === 0) ? 'stopped' : 'error';
    if (serverState === 'error' && !serverError) serverError = 'Server exited with code ' + code + '.';
    notifyStatus();
  });
  notifyStatus();
  return { ok: true, state: serverState, message: 'Starting local server…' };
}
function stopServer() {
  if (!serverProcess) { serverState = 'stopped'; notifyStatus(); return { ok: true, state: serverState }; }
  serverState = 'stopping'; if (serverProcess.connected) serverProcess.send({ type: 'shutdown' }); else serverProcess.kill('SIGTERM');
  const child = serverProcess;
  const fallback = setTimeout(() => { if (serverProcess === child) child.kill('SIGTERM'); }, 8000); fallback.unref();
  notifyStatus();
  return { ok: true, state: serverState, message: 'Stopping server…' };
}
function openClient(value) {
  let url;
  try { const parsed = new URL(value); if (parsed.protocol !== 'https:') throw new Error(); url = parsed.toString(); }
  catch { throw new Error('Enter a valid HTTPS URL, such as https://chat.example.com.'); }
  if (clientWindow && !clientWindow.isDestroyed()) clientWindow.close();
  clientWindow = new BrowserWindow({ width: 1200, height: 820, minWidth: 360, minHeight: 520, title: 'Secure Chat', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  clientWindow.loadURL(url);
  clientWindow.on('closed', () => { clientWindow = null; });
  return { ok: true };
}
ipcMain.handle('server:start', () => startServer());
ipcMain.handle('server:stop', () => stopServer());
ipcMain.handle('server:status', () => status());
ipcMain.handle('server:settings', () => ({ ...settings }));
ipcMain.handle('server:settings:save', async (_event, input) => {
  if (serverProcess) throw new Error('Stop the server before changing settings.');
  const port = Number(input && input.port);
  const maxMessageLength = Number(input && input.maxMessageLength);
  const sessionTtlHours = Number(input && input.sessionTtlHours);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be from 1024 to 65535.');
  if (!['local', 'lan'].includes(input.networkMode)) throw new Error('Choose Local only or Local network.');
  if (!Number.isInteger(maxMessageLength) || maxMessageLength < 100 || maxMessageLength > 4000) throw new Error('Message length must be from 100 to 4000.');
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) throw new Error('Session lifetime must be from 1 to 720 hours.');
  settings = { port, networkMode: input.networkMode, allowRegistration: input.allowRegistration === true, maxMessageLength, sessionTtlHours };
  saveSettings();
  await ensureCertificate(true);
  logLine('Settings saved. networkMode=' + settings.networkMode + ', port=' + settings.port);
  notifyStatus();
  return { ok: true, status: status() };
});
ipcMain.handle('server:certificate:open', async () => shell.openPath(certDir));
ipcMain.handle('client:open', (_event, url) => openClient(url));
ipcMain.handle('app:open-logs', async () => { ensureDirectories(); return shell.openPath(path.join(logDir, 'server.log')); });
app.whenReady().then(async () => { ensureDirectories(); loadSettings(); await ensureCertificate(); setLocalCertificateTrust(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
let quitting = false;
app.on('before-quit', event => {
  if (serverProcess && !quitting) {
    event.preventDefault(); quitting = true; serverState = 'stopping';
    const child = serverProcess;
    child.once('exit', () => { serverProcess = null; app.quit(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill('SIGTERM');
    const fallback = setTimeout(() => { if (serverProcess === child) child.kill('SIGTERM'); }, 5000); fallback.unref();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
