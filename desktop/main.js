const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

// >>> Troque pela URL do seu app publicado no Vercel <<<
const APP_URL = 'https://SEU-APP.vercel.app';

let mainWindow = null;
let pickerWindow = null;
let pendingDisplayMediaCallback = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(APP_URL);
}

function openSourcePicker() {
  pickerWindow = new BrowserWindow({
    width: 720,
    height: 480,
    modal: true,
    parent: mainWindow || undefined,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#161922',
    webPreferences: {
      preload: path.join(__dirname, 'preload-picker.js'),
      contextIsolation: true
    }
  });

  pickerWindow.loadFile('picker.html');

  ipcMain.once('picker:selected', async (_event, sourceId) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 300, height: 200 }
    });
    const chosen = sources.find((s) => s.id === sourceId);
    if (pendingDisplayMediaCallback) {
      pendingDisplayMediaCallback(chosen ? { video: chosen, audio: 'loopback' } : null);
    }
    pendingDisplayMediaCallback = null;
    if (pickerWindow) pickerWindow.close();
  });

  ipcMain.once('picker:cancel', () => {
    if (pendingDisplayMediaCallback) pendingDisplayMediaCallback(null);
    pendingDisplayMediaCallback = null;
    if (pickerWindow) pickerWindow.close();
  });

  pickerWindow.on('closed', () => {
    ipcMain.removeAllListeners('picker:selected');
    ipcMain.removeAllListeners('picker:cancel');
    if (pendingDisplayMediaCallback) {
      pendingDisplayMediaCallback(null);
      pendingDisplayMediaCallback = null;
    }
    pickerWindow = null;
  });
}

app.whenReady().then(() => {
  // permite o microfone sem exigir confirmação nativa extra do Windows
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  // toda vez que a página pedir getDisplayMedia (compartilhar tela), abre o seletor
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    pendingDisplayMediaCallback = callback;
    openSourcePicker();
  });

  ipcMain.handle('picker:get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 300, height: 200 }
    });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
