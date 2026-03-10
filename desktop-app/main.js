// ── GuildVoice Desktop – Main Process ──
// Electron main process: window management, global shortcuts, tray, auto-updater,
// media permissions, and IPC for screenshare source enumeration.

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, session, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
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

// ── Application state ──
let mainWindow = null;
let tray = null;

// Current shortcut configuration
const shortcuts = {
  ptt:     { enabled: false, key: 'Space' },
  mute:    { enabled: false, key: 'KeyM' },
  pause:   { enabled: false, key: 'KeyB' },
};

// PTT repeat-timer for key release detection
let pttRepeatTimer = null;
const PTT_REPEAT_TIMEOUT_MS = 200;

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
function registerShortcuts() {
  globalShortcut.unregisterAll();

  // Push-To-Talk shortcut
  if (shortcuts.ptt.enabled) {
    const accel = codeToAccelerator(shortcuts.ptt.key);
    if (accel) {
      globalShortcut.register(accel, () => {
        if (!mainWindow) return;

        // On first press, emit ptt-down
        // The global shortcut fires repeatedly while held.
        // Use a repeat-timer: each repeat resets the timer.
        // When the timer expires, treat it as key release (ptt-up).
        if (!pttRepeatTimer) {
          mainWindow.webContents.send('shortcut', 'ptt-down');
        }

        clearTimeout(pttRepeatTimer);
        pttRepeatTimer = setTimeout(() => {
          pttRepeatTimer = null;
          if (mainWindow) {
            mainWindow.webContents.send('shortcut', 'ptt-up');
          }
        }, PTT_REPEAT_TIMEOUT_MS);
      });
    }
  }

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
  clearTimeout(pttRepeatTimer);
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
