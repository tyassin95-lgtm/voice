// ── GuildVoice Desktop – Main Process ──
// Electron main process: window management, global shortcuts, tray, auto-updater,
// media permissions, and IPC for screenshare source enumeration.

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, session, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const { GlobalKeyboardListener } = require('node-global-key-listener');
const path = require('path');

// ── Keyboard code → Electron accelerator mapping ──
const CODE_TO_ACCELERATOR = {
  Space: 'Space', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Return', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec', NumpadEnter: 'Enter',
  Numpad0: 'num0', Numpad1: 'num1', Numpad2: 'num2', Numpad3: 'num3',
  Numpad4: 'num4', Numpad5: 'num5', Numpad6: 'num6', Numpad7: 'num7',
  Numpad8: 'num8', Numpad9: 'num9',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

// Map KeyA-KeyZ and Digit0-Digit9
for (let i = 65; i <= 90; i++) {
  const ch = String.fromCharCode(i);
  CODE_TO_ACCELERATOR[`Key${ch}`] = ch;
}
for (let i = 0; i <= 9; i++) {
  CODE_TO_ACCELERATOR[`Digit${i}`] = String(i);
}

function codeToAccelerator(code) {
  return CODE_TO_ACCELERATOR[code] || null;
}

// ── node-global-key-listener name → KeyboardEvent.code mapping ──
// Used for the global PTT listener which provides true keydown/keyup events.
const NGL_NAME_TO_CODE = {
  SPACE: 'Space', RETURN: 'Enter', ESCAPE: 'Escape', TAB: 'Tab',
  BACK: 'Backspace', DELETE: 'Delete', INSERT: 'Insert',
  HOME: 'Home', END: 'End', PRIOR: 'PageUp', NEXT: 'PageDown',
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  OEM_1: 'Semicolon', OEM_2: 'Slash', OEM_3: 'Backquote',
  OEM_4: 'BracketLeft', OEM_5: 'Backslash', OEM_6: 'BracketRight',
  OEM_7: 'Quote', OEM_COMMA: 'Comma', OEM_MINUS: 'Minus',
  OEM_PERIOD: 'Period', OEM_PLUS: 'Equal',
  ADD: 'NumpadAdd', SUBTRACT: 'NumpadSubtract',
  MULTIPLY: 'NumpadMultiply', DIVIDE: 'NumpadDivide',
  DECIMAL: 'NumpadDecimal',
  NUMPAD0: 'Numpad0', NUMPAD1: 'Numpad1', NUMPAD2: 'Numpad2',
  NUMPAD3: 'Numpad3', NUMPAD4: 'Numpad4', NUMPAD5: 'Numpad5',
  NUMPAD6: 'Numpad6', NUMPAD7: 'Numpad7', NUMPAD8: 'Numpad8',
  NUMPAD9: 'Numpad9',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

// Letters A-Z → KeyA-KeyZ, Digits 0-9 → Digit0-Digit9
for (let i = 65; i <= 90; i++) {
  const ch = String.fromCharCode(i);
  NGL_NAME_TO_CODE[ch] = `Key${ch}`;
}
for (let i = 0; i <= 9; i++) {
  NGL_NAME_TO_CODE[String(i)] = `Digit${i}`;
}

function nglNameToCode(name) {
  return NGL_NAME_TO_CODE[name] || null;
}

// ── Application state ──
let mainWindow = null;
let tray = null;

// Current shortcut configuration
const shortcuts = {
  ptt:     { enabled: false, key: 'Space' },
  mute:    { enabled: false, key: 'KeyM' },
  pause:   { enabled: false, key: 'KeyB' },
};

// ── Global keyboard listener for PTT ──
// Uses node-global-key-listener for true keydown/keyup detection that works
// even when the Electron window is unfocused, minimized, or another app has focus.
const keyboard = new GlobalKeyboardListener();
let pttDown = false; // tracks current PTT key state

keyboard.addListener((e) => {
  if (!mainWindow || !shortcuts.ptt.enabled) return;

  const code = nglNameToCode(e.name);
  if (code !== shortcuts.ptt.key) return;

  if (e.state === 'DOWN' && !pttDown) {
    pttDown = true;
    mainWindow.webContents.send('shortcut', 'ptt-down');
  } else if (e.state === 'UP' && pttDown) {
    pttDown = false;
    mainWindow.webContents.send('shortcut', 'ptt-up');
  }
});

// ── Window creation ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
  });

  // Load the web app
  // Set VOICE_URL to point at your production server (e.g. https://example.com/voice/).
  // Defaults to the local development server.
  const appUrl = process.env.VOICE_URL || 'http://localhost:3000/voice/';
  mainWindow.loadURL(appUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Global shortcut management ──
// PTT uses the global keyboard listener (above) for reliable keydown/keyup.
// Mute and broadcast-pause only need single-press detection, so globalShortcut is fine.
function registerShortcuts() {
  globalShortcut.unregisterAll();

  // Reset PTT state when shortcuts are re-registered (key may have changed)
  pttDown = false;

  // Mute toggle shortcut
  if (shortcuts.mute.enabled) {
    const accel = codeToAccelerator(shortcuts.mute.key);
    if (accel) {
      globalShortcut.register(accel, () => {
        if (mainWindow) {
          mainWindow.webContents.send('shortcut', 'toggle-mute');
        }
      });
    }
  }

  // Broadcast pause toggle shortcut
  if (shortcuts.pause.enabled) {
    const accel = codeToAccelerator(shortcuts.pause.key);
    if (accel) {
      globalShortcut.register(accel, () => {
        if (mainWindow) {
          mainWindow.webContents.send('shortcut', 'toggle-pause');
        }
      });
    }
  }
}

// ── IPC handlers ──

// Settings synchronization from renderer
ipcMain.on('sync-settings', (_event, { type, enabled, key }) => {
  if (type === 'ptt') {
    shortcuts.ptt = { enabled, key };
  } else if (type === 'mute') {
    shortcuts.mute = { enabled, key };
  } else if (type === 'pause') {
    shortcuts.pause = { enabled, key };
  }
  registerShortcuts();
});

// Desktop source enumeration for screen sharing
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});

// ── Tray integration ──
function createTray() {
  // Use a simple icon path; falls back gracefully if missing
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch {
    // If icon doesn't exist yet (dev mode), skip tray
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('GuildVoice');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Auto updater ──
function initAutoUpdater() {
  autoUpdater.autoDownload = true;

  const events = [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error',
  ];

  events.forEach((eventName) => {
    autoUpdater.on(eventName, (data) => {
      if (mainWindow) {
        mainWindow.webContents.send('update-status', {
          event: eventName,
          data: data || null,
        });
      }
    });
  });

  autoUpdater.checkForUpdatesAndNotify();
}

// ── Media permissions ──
function setupMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ['media', 'microphone', 'camera', 'screen'].includes(permission);
      callback(allowed);
    }
  );
}

// ── App lifecycle ──
app.whenReady().then(() => {
  setupMediaPermissions();
  createWindow();
  createTray();
  registerShortcuts();
  initAutoUpdater();

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keyboard.kill();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
