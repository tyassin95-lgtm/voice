// ── GuildVoice Desktop – Main Process ──
// Electron main process: window management, global hotkeys via iohook, tray,
// auto-updater, media permissions, and IPC for screenshare source enumeration.

const { app, BrowserWindow, ipcMain, Tray, Menu, session, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const iohook = require('iohook');
const path = require('path');

// ── iohook scan code → W3C KeyboardEvent.code mapping ──
// iohook fires numeric hardware scan codes; the shortcut settings use
// W3C KeyboardEvent.code strings (e.g. 'KeyV', 'Space').
const IOHOOK_TO_CODE = {
  // Letters (scan codes follow physical keyboard layout)
  30: 'KeyA', 48: 'KeyB', 46: 'KeyC', 32: 'KeyD', 18: 'KeyE',
  33: 'KeyF', 34: 'KeyG', 35: 'KeyH', 23: 'KeyI', 36: 'KeyJ',
  37: 'KeyK', 38: 'KeyL', 50: 'KeyM', 49: 'KeyN', 24: 'KeyO',
  25: 'KeyP', 16: 'KeyQ', 19: 'KeyR', 31: 'KeyS', 20: 'KeyT',
  22: 'KeyU', 47: 'KeyV', 17: 'KeyW', 45: 'KeyX', 21: 'KeyY',
  44: 'KeyZ',
  // Digits
  2: 'Digit1', 3: 'Digit2', 4: 'Digit3', 5: 'Digit4', 6: 'Digit5',
  7: 'Digit6', 8: 'Digit7', 9: 'Digit8', 10: 'Digit9', 11: 'Digit0',
  // Function keys
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
  // Special keys
  57: 'Space', 28: 'Enter', 1: 'Escape', 15: 'Tab', 14: 'Backspace',
  211: 'Delete', 210: 'Insert', 199: 'Home', 207: 'End',
  201: 'PageUp', 209: 'PageDown',
  // Arrow keys
  200: 'ArrowUp', 208: 'ArrowDown', 203: 'ArrowLeft', 205: 'ArrowRight',
  // Punctuation / symbols
  41: 'Backquote', 12: 'Minus', 13: 'Equal',
  26: 'BracketLeft', 27: 'BracketRight', 43: 'Backslash',
  39: 'Semicolon', 40: 'Quote', 51: 'Comma', 52: 'Period', 53: 'Slash',
  // Numpad
  69: 'NumLock', 82: 'Numpad0', 79: 'Numpad1', 80: 'Numpad2',
  81: 'Numpad3', 75: 'Numpad4', 76: 'Numpad5', 77: 'Numpad6',
  71: 'Numpad7', 72: 'Numpad8', 73: 'Numpad9',
  78: 'NumpadAdd', 74: 'NumpadSubtract',
  55: 'NumpadMultiply', 181: 'NumpadDivide',
  83: 'NumpadDecimal', 156: 'NumpadEnter',
};

function iohookCodeToKey(keycode) {
  return IOHOOK_TO_CODE[keycode] || null;
}

// ── Application state ──
let mainWindow = null;
let tray = null;

// Current shortcut configuration (matches the settings object in the renderer)
const shortcuts = {
  ptt:   { key: 'KeyV', enabled: true },
  mute:  { key: 'KeyM', enabled: true },
  pause: { key: 'KeyB', enabled: true },
};

// ── Central Hotkey Manager state ──
// pressedKeys   – currently held keys (W3C code strings)
// pttActive     – whether PTT is currently engaged
// firedToggles  – toggle shortcuts that have already fired for the current press
//                 (prevents repeat-firing while a key is held)
const pressedKeys  = new Set();
let   pttActive    = false;
const firedToggles = new Set();

// ── Hotkey Manager: iohook-based global keyboard system ──
// Replaces both globalShortcut and node-global-key-listener with a single
// low-level OS input hook that reliably detects keydown/keyup even when
// the Electron window is not focused.

function startHotkeys() {
  iohook.on('keydown', (event) => {
    const code = iohookCodeToKey(event.keycode);
    if (!code || !mainWindow) return;

    pressedKeys.add(code);

    // PTT: fire on transition from inactive → active
    if (shortcuts.ptt.enabled && code === shortcuts.ptt.key && !pttActive) {
      pttActive = true;
      mainWindow.webContents.send('shortcut', 'ptt-down');
    }

    // Toggle mute: fire once per press
    if (shortcuts.mute.enabled && code === shortcuts.mute.key && !firedToggles.has('mute')) {
      firedToggles.add('mute');
      mainWindow.webContents.send('shortcut', 'toggle-mute');
    }

    // Toggle broadcast pause: fire once per press
    if (shortcuts.pause.enabled && code === shortcuts.pause.key && !firedToggles.has('pause')) {
      firedToggles.add('pause');
      mainWindow.webContents.send('shortcut', 'toggle-pause');
    }
  });

  iohook.on('keyup', (event) => {
    const code = iohookCodeToKey(event.keycode);
    if (!code || !mainWindow) return;

    pressedKeys.delete(code);

    // PTT: fire on transition from active → inactive
    if (shortcuts.ptt.enabled && code === shortcuts.ptt.key && pttActive) {
      pttActive = false;
      mainWindow.webContents.send('shortcut', 'ptt-up');
    }

    // Allow toggle shortcuts to fire again on the next press
    if (code === shortcuts.mute.key) firedToggles.delete('mute');
    if (code === shortcuts.pause.key) firedToggles.delete('pause');
  });

  iohook.start();
}

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

// ── Global shortcut state reset ──
// Called when settings change to ensure clean transition.
function resetHotkeyState() {
  pressedKeys.clear();
  pttActive = false;
  firedToggles.clear();
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
  resetHotkeyState();
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
  startHotkeys();
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
  iohook.stop();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
