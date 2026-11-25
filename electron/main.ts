import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { initDatabase } from './database/index';
import { registerHandlers } from './ipc/handlers';
import { YahooFinanceProvider } from './providers/yahooFinanceProvider';
import { PriceService } from './services/priceService';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Fix GPU process crash on some macOS configurations
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err);
  dialog.showErrorBox('啟動錯誤', err.stack ?? err.message);
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 16 },
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    console.log('[Main] Window ready-to-show');
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Main] did-fail-load:', code, desc);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Main] render-process-gone:', details);
  });


  console.log('[Main] Loading URL:', MAIN_WINDOW_VITE_DEV_SERVER_URL ?? 'file');

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
}

app.whenReady().then(() => {
  try {
    console.log('[Main] Initializing database...');
    initDatabase();
    console.log('[Main] Database initialized');
    const provider = new YahooFinanceProvider();
    const priceService = new PriceService(provider);
    registerHandlers(priceService);
    console.log('[Main] Handlers registered');
    createWindow();
  } catch (err) {
    console.error('[Main] startup error:', err);
    dialog.showErrorBox('啟動失敗', String(err));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
