const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 360,
    height: 640,
    minWidth: 320,
    minHeight: 500,
    title: 'Vryx',
    icon: path.join(__dirname, '../public/logo.png'),
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#0a0a0a',
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

const si = require('systeminformation');
const { spawn } = require('child_process');
const fs = require('fs');

const isPackaged = app.isPackaged;
const nodeAndWorkerDir = isPackaged
  ? path.join(process.resourcesPath, 'nodeAndWorker')
  : path.resolve(__dirname, '../../nodeAndWorker');

let workerProcess = null;

// Heuristics for Mac GPUs (TFlops and TDP approximations since Mac GPUs share memory and TDP with CPU)
function getMacGpuStats(model) {
  if (model.includes('M3 Max')) return { tflops: 18, tdp: 60 };
  if (model.includes('M3 Pro')) return { tflops: 14, tdp: 40 };
  if (model.includes('M3')) return { tflops: 8, tdp: 20 };
  if (model.includes('M2 Max')) return { tflops: 14, tdp: 50 };
  if (model.includes('M2 Pro')) return { tflops: 10, tdp: 35 };
  if (model.includes('M2')) return { tflops: 7, tdp: 20 };
  if (model.includes('M1 Max')) return { tflops: 10, tdp: 50 };
  if (model.includes('M1 Pro')) return { tflops: 7, tdp: 35 };
  if (model.includes('M1')) return { tflops: 5, tdp: 20 };
  return { tflops: 10, tdp: 50 }; // Default fallback
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

app.whenReady().then(() => {
  ipcMain.handle('get-hardware-stats', async () => {
    try {
      const graphics = await si.graphics();
      const cpu = await si.cpu();
      const mem = await si.mem();

      let gpuName = 'Apple M-Series';
      let vramGb = Math.round(mem.total / (1024 ** 3)); // Apple uses Unified Memory

      if (graphics.controllers && graphics.controllers.length > 0) {
        gpuName = graphics.controllers[0].model || gpuName;
        if (graphics.controllers[0].vram) {
           vramGb = graphics.controllers[0].vram > 1000 ? Math.round(graphics.controllers[0].vram / 1024) : graphics.controllers[0].vram;
        }
      }

      const tempInfo = await si.cpuTemperature();
      const temp = tempInfo.main || 42;

      // Real formulas from simulator
      const macStats = getMacGpuStats(gpuName);
      const vramF = clamp(0.88 + (vramGb / 24) * 0.16, 0.9, 1.22);
      
      const WORKER_EUR_PER_TFLOP_HOUR = 0.0015;
      const hoursOnlineMonth = 24 * 30; // 100% utilization
      const mult = 1.06; // Race-pool mode
      
      const grossMonthlyEuro = macStats.tflops * WORKER_EUR_PER_TFLOP_HOUR * hoursOnlineMonth * mult * vramF;
      const averagePowerKw = (macStats.tdp / 1000) * 0.6;
      const electricityMonthlyEuro = averagePowerKw * hoursOnlineMonth * 0.25; // 0.25 EUR/kWh
      const netMonthlyEuro = grossMonthlyEuro - electricityMonthlyEuro;
      
      const msrp = 2500; // Fake MSRP for Mac since it's a whole computer
      const roiMonths = netMonthlyEuro > 0 ? (msrp / netMonthlyEuro) : null;

      return {
        gpu: gpuName,
        vram: `${vramGb} GB`,
        temp: `${Math.round(temp)}°C`,
        stats: {
          memoryFactor: `×${vramF.toFixed(2)}`,
          grossMonthly: `${grossMonthlyEuro.toFixed(2)} €`,
          electricMonthly: `−${electricityMonthlyEuro.toFixed(2)} €`,
          netMonthly: `${netMonthlyEuro.toFixed(2)} €`,
          roi: roiMonths ? `${Math.round(roiMonths)} mois` : 'N/A',
          modeMultiplier: `×${mult}`
        }
      };
    } catch (e) {
      console.error(e);
      return null;
    }
  });

  ipcMain.handle('start-worker', (event, userId) => {
    if (workerProcess) return;

    // Clean up any zombie processes to free ports
    try {
      spawn('pkill', ['-f', 'inference_server.py']);
      spawn('pkill', ['-f', 'rust-daemon']);
    } catch(e) {}

    const workerScript = path.join(nodeAndWorkerDir, 'start-worker.sh');
    if (!fs.existsSync(workerScript)) {
      event.sender.send('worker-status', { state: 'error', message: 'Script non trouvé' });
      return;
    }

    event.sender.send('worker-status', { state: 'searching', progress: 10 });

    const env = Object.assign({}, process.env);
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:/Users/julien/.cargo/bin:${env.PATH}`;
    env.VELOCITY_ROLE = 'worker';

    // Pass user ID as argument if available
    const args = userId ? ['--user-id', userId.toString()] : [];

    workerProcess = spawn('bash', [workerScript, ...args], {
      cwd: nodeAndWorkerDir,
      env: env
    });

    let connectionTimeout = null;

    const safeSend = (channel, data) => {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send(channel, data);
      }
    };

    workerProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString('utf8');
      const output = rawOutput.replace(/[^\x20-\x7E\x0A\x0D\u00C0-\u00FF]/g, '');
      if (output.trim()) {
        console.log(`[WORKER]: ${output.trim()}`);
      }
      
      const lowerOutput = output.toLowerCase();
      
      if (lowerOutput.includes('grpc pret')) {
        safeSend('worker-status', { state: 'connecting', progress: 50 });
      }
      
      if (
        lowerOutput.includes('heartbeat ok') || 
        lowerOutput.includes('en ecoute sur') || 
        lowerOutput.includes('en écoute sur') ||
        lowerOutput.includes('success') ||
        lowerOutput.includes('p2p_ready')
      ) {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        safeSend('worker-status', { state: 'working', progress: 100 });
      }

      if (output.includes('[<] Requête P2P reçue')) {
        const matchCount = (output.match(/\[<\] Requête P2P reçue/g) || []).length;
        if (matchCount > 0) {
          safeSend('worker-token-generated', matchCount);
        }
      }
    });

    workerProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.error(`[WORKER ERR]: ${output}`);
    });

    workerProcess.on('close', () => {
      workerProcess = null;
      if (connectionTimeout) clearTimeout(connectionTimeout);
      safeSend('worker-status', { state: 'stopped', progress: 0 });
    });
  });

  ipcMain.handle('stop-worker', () => {
    if (workerProcess) {
      workerProcess.kill('SIGINT');
      workerProcess = null;
    }
    // Force kill zombies
    try {
      spawn('pkill', ['-f', 'inference_server.py']);
      spawn('pkill', ['-f', 'rust-daemon']);
    } catch(e) {}
  });

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (workerProcess) workerProcess.kill('SIGINT');
  if (process.platform !== 'darwin') app.quit();
});

