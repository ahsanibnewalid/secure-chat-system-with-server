'use strict';
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const selfsigned = require('selfsigned');

let managerWindow, clientWindow, serverProcess = null;
let serverState = 'stopped', serverError = '', localFingerprint = '';
const userData = app.getPath('userData');
const dataDir = path.join(userData, 'data'), certDir = path.join(userData, 'certs'), logDir = path.join(userData, 'logs');
const keyPath = path.join(certDir, 'server-key.pem'), certPath = path.join(certDir, 'server-cert.pem');
const port = 8443;

function ensureDirectories() { for (const dir of [dataDir, certDir, logDir]) fs.mkdirSync(dir, { recursive: true }); }
async function ensureCertificate() {
  ensureDirectories();
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const generated = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      keySize: 2048, days: 365,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }]
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
function status() { return { state: serverState, pid: serverProcess ? serverProcess.pid : null, localUrl: 'https://127.0.0.1:' + port, error: serverError, logPath: path.join(logDir, 'server.log') }; }
function notifyStatus() { if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send('server-status', status()); }
async function startServer() {
  if (serverProcess && !serverProcess.killed) return { ok: true, state: serverState, message: 'Server is already running.' };
  await ensureCertificate();
  serverState = 'starting'; serverError = '';
  const script = path.join(app.getAppPath(), 'src', 'server.js');
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, TLS_KEY: keyPath, TLS_CERT: certPath, ALLOW_REGISTRATION: 'true' };
  delete childEnv.ADMIN_BOOTSTRAP_TOKEN;
  const child = spawn(process.execPath, [script], { cwd: userData, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  serverProcess = child;
  child.stdout.on('data', b => { const s = b.toString(); logLine(s.trimEnd()); if (s.includes('Secure Chat listening')) { serverState = 'running'; notifyStatus(); } });
  child.stderr.on('data', b => { const s = b.toString(); logLine('ERROR ' + s.trimEnd()); serverError = s.trim().slice(-500); notifyStatus(); });
  child.once('error', err => { serverState = 'error'; serverError = err.message; serverProcess = null; notifyStatus(); });
  child.once('exit', (code, signal) => {
    logLine('Server process exited (code=' + code + ', signal=' + signal + ')');
    serverProcess = null;
    if (serverState !== 'stopping') serverState = code === 0 ? 'stopped' : 'error';
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
ipcMain.handle('client:open', (_event, url) => openClient(url));
ipcMain.handle('app:open-logs', async () => { ensureDirectories(); return shell.openPath(path.join(logDir, 'server.log')); });
app.whenReady().then(async () => { ensureDirectories(); await ensureCertificate(); setLocalCertificateTrust(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('before-quit', () => { if (serverProcess) { serverState = 'stopping'; if (serverProcess.connected) serverProcess.send({ type: 'shutdown' }); else serverProcess.kill('SIGTERM'); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
