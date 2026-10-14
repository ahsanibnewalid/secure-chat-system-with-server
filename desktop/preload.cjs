'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('secureChatDesktop', {
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getStatus: () => ipcRenderer.invoke('server:status'),
  getSettings: () => ipcRenderer.invoke('server:settings'),
  saveSettings: value => ipcRenderer.invoke('server:settings:save', value),
  openCertificateFolder: () => ipcRenderer.invoke('server:certificate:open'),
  openClient: url => ipcRenderer.invoke('client:open', url),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  onStatus: callback => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('server-status', handler);
    return () => ipcRenderer.removeListener('server-status', handler);
  }
});
