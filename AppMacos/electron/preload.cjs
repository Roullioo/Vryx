const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  getHardwareStats: () => ipcRenderer.invoke('get-hardware-stats'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  validateConfig: (config) => ipcRenderer.invoke('validate-config', config),
  getModelCatalog: () => ipcRenderer.invoke('get-model-catalog'),
  getWorkerState: () => ipcRenderer.invoke('get-worker-state'),
  getWorkerMetrics: () => ipcRenderer.invoke('get-worker-metrics'),
  startWorker: (config) => ipcRenderer.invoke('start-worker', config),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  openCacheDir: () => ipcRenderer.invoke('open-cache-dir'),
  getEarnings: (token) => ipcRenderer.invoke('get-earnings', token),
  getNetworkStats: () => ipcRenderer.invoke('get-network-stats'),
  authLogin: (credentials) => ipcRenderer.invoke('auth-login', credentials),
  authRegister: (credentials) => ipcRenderer.invoke('auth-register', credentials),
  authLogout: () => ipcRenderer.invoke('auth-logout'),
  authGoogle: () => ipcRenderer.invoke('auth-google'),
  probeDependency: (name) => ipcRenderer.invoke('probe-dependency', name),
  onWorkerStatus: (callback) => {
    ipcRenderer.removeAllListeners('worker-status');
    ipcRenderer.on('worker-status', (_event, value) => callback(value));
  },
  onWorkerLog: (callback) => {
    ipcRenderer.removeAllListeners('worker-log');
    ipcRenderer.on('worker-log', (_event, value) => callback(value));
  },
  onWorkerMetrics: (callback) => {
    ipcRenderer.removeAllListeners('worker-metrics');
    ipcRenderer.on('worker-metrics', (_event, value) => callback(value));
  },
  onAuthUpdated: (callback) => {
    ipcRenderer.removeAllListeners('auth-updated');
    ipcRenderer.on('auth-updated', (_event, value) => callback(value));
  },
  getRole: () => process.env.VELOCITY_ROLE || 'worker',
});
