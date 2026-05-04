const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  getHardwareStats: () => ipcRenderer.invoke('get-hardware-stats'),
  startWorker: (userId) => ipcRenderer.invoke('start-worker', userId),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  onWorkerStatus: (callback) => {
    ipcRenderer.removeAllListeners('worker-status');
    ipcRenderer.on('worker-status', (_event, value) => callback(value));
  },
  onTokenGenerated: (callback) => {
    ipcRenderer.removeAllListeners('worker-token-generated');
    ipcRenderer.on('worker-token-generated', (_event, count) => callback(count));
  },
  getRole: () => process.env.VELOCITY_ROLE || 'worker'
});
