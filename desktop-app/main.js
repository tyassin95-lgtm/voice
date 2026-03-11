// ── GuildVoice Desktop – Main Process ──
// Electron main process: window management, global hotkeys via native Windows API,
// tray, auto-updater, media permissions, and IPC for screenshare source enumeration.
//
// ── WHY NATIVE WINDOWS API INSTEAD OF iohook OR globalShortcut ──
//
// 1. Electron's built-in globalShortcut API:
//    - Unreliable when the app is completely unfocused or minimized on some systems.
//    - Does not support key-up detection (needed for Push-to-Talk).
//    - Limited to modifier+key combinations for many keys.
//
// 2. iohook / uIOhook:
//    - Requires native C++ compilation that frequently breaks between Electron versions.
//    - Heavy dependency with complex build requirements (node-gyp, platform SDKs).
//    - Often abandoned or poorly maintained for newer Electron releases.
//
// 3. Native Windows API via ffi-napi (this implementation):
//    - Direct access to user32.dll's GetAsyncKeyState for reliable key state polling.
//    - Works globally — detects keys even when the app is minimized or unfocused.
//    - No key event consumption — pressed keys still reach other applications.
//    - Supports both key-down and key-up detection (essential for Push-to-Talk).
//    - Stable across Electron versions since it uses the OS API directly.
//    - Replicates Discord's global hotkey behavior exactly.
//
// ── WHY GetAsyncKeyState INSTEAD OF RegisterHotKey ──
//
// RegisterHotKey (Win32 API) was considered but has critical limitations:
//    - It CONSUMES key events globally — other apps never see the keypress
//      (e.g., Space as PTT would prevent typing spaces in every application).
//    - It cannot detect key release — only fires WM_HOTKEY on key-down.
//    - It requires a message-only window and message pump for thread-safe operation.
//    - It is designed for modifier+key combos (Ctrl+C), not standalone keys (Space).
//
// GetAsyncKeyState is the preferred approach because:
//    - It observes key state without consuming events (non-invasive).
//    - It detects both pressed and released states via the high-order bit (0x8000).
//    - It requires no message loop — simple polling via setInterval.
//    - It is what game engines and Discord-like apps use for global input detection.

const { app, BrowserWindow, ipcMain, Tray, Menu, session, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// ── Native Windows API for global hotkeys ──
// Only loaded on Windows. Other platforms fall back to in-window keyboard events
// handled by the renderer process (see public/js/app.js keydown/keyup listeners).
let user32 = null;
let hotkeyPollInterval = null;

if (process.platform === 'win32') {
  try {
    const ffi = require('ffi-napi');
    // ref-napi is required by ffi-napi for pointer and type definitions.
    require('ref-napi');
    // ref-struct-napi is loaded here so it is available for complex Win32 struct
    // definitions (e.g., MSG, KBDLLHOOKSTRUCT) if RegisterHotKey or
    // SetWindowsHookEx approaches are adopted in the future.  It is not used by
    // the current GetAsyncKeyState polling implementation, so a load failure is
    // non-fatal and silently ignored.
    try { require('ref-struct-napi'); } catch (_) { /* optional, unused currently */ }

    // Load user32.dll — the core Windows API library for keyboard and UI input.
    user32 = ffi.Library('user32', {
      // GetAsyncKeyState: Determines whether a key is up or down at the time
      // the function is called. Returns a SHORT where bit 15 (0x8000) indicates
      // the key is currently pressed. Works globally regardless of window focus.
      GetAsyncKeyState: ['short', ['int']],
    });

    console.log('[Hotkey] Native Windows API (user32.dll) loaded successfully');
  } catch (err) {
    console.error('[Hotkey] Failed to load native Windows API:', err.message);
    console.error('[Hotkey] Install dependencies: npm install ffi-napi ref-napi ref-struct-napi');
    console.error('[Hotkey] Then rebuild for Electron: npx electron-rebuild');
    console.error('[Hotkey] Global hotkeys will be disabled — in-window shortcuts still work.');
  }
}

// ── W3C KeyboardEvent.code → Windows Virtual Key (VK) code mapping ──
// The renderer uses W3C KeyboardEvent.code strings (e.g. 'KeyV', 'Space').
// Windows GetAsyncKeyState expects VK_* integer codes.
// This central mapping converts between the two systems so that the renderer's
// keybind settings work seamlessly with the native Windows polling.
const CODE_TO_VK = {
  // Letters (VK_A through VK_Z = 0x41–0x5A)
  'KeyA': 0x41, 'KeyB': 0x42, 'KeyC': 0x43, 'KeyD': 0x44, 'KeyE': 0x45,
  'KeyF': 0x46, 'KeyG': 0x47, 'KeyH': 0x48, 'KeyI': 0x49, 'KeyJ': 0x4A,
  'KeyK': 0x4B, 'KeyL': 0x4C, 'KeyM': 0x4D, 'KeyN': 0x4E, 'KeyO': 0x4F,
  'KeyP': 0x50, 'KeyQ': 0x51, 'KeyR': 0x52, 'KeyS': 0x53, 'KeyT': 0x54,
  'KeyU': 0x55, 'KeyV': 0x56, 'KeyW': 0x57, 'KeyX': 0x58, 'KeyY': 0x59,
  'KeyZ': 0x5A,
  // Digits (VK_0 through VK_9 = 0x30–0x39)
  'Digit0': 0x30, 'Digit1': 0x31, 'Digit2': 0x32, 'Digit3': 0x33,
  'Digit4': 0x34, 'Digit5': 0x35, 'Digit6': 0x36, 'Digit7': 0x37,
  'Digit8': 0x38, 'Digit9': 0x39,
  // Function keys (VK_F1 through VK_F12 = 0x70–0x7B)
  'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74, 'F6': 0x75,
  'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B,
  // Special keys
  'Space': 0x20, 'Enter': 0x0D, 'Escape': 0x1B, 'Tab': 0x09, 'Backspace': 0x08,
  'Delete': 0x2E, 'Insert': 0x2D, 'Home': 0x24, 'End': 0x23,
  'PageUp': 0x21, 'PageDown': 0x22,
  // Arrow keys
  'ArrowUp': 0x26, 'ArrowDown': 0x28, 'ArrowLeft': 0x25, 'ArrowRight': 0x27,
  // Punctuation / symbols (OEM virtual key codes)
  'Backquote': 0xC0, 'Minus': 0xBD, 'Equal': 0xBB,
  'BracketLeft': 0xDB, 'BracketRight': 0xDD, 'Backslash': 0xDC,
  'Semicolon': 0xBA, 'Quote': 0xDE, 'Comma': 0xBC, 'Period': 0xBE, 'Slash': 0xBF,
  // Numpad (VK_NUMPAD0 through VK_NUMPAD9 = 0x60–0x69)
  'NumLock': 0x90, 'Numpad0': 0x60, 'Numpad1': 0x61, 'Numpad2': 0x62,
  'Numpad3': 0x63, 'Numpad4': 0x64, 'Numpad5': 0x65, 'Numpad6': 0x66,
  'Numpad7': 0x67, 'Numpad8': 0x68, 'Numpad9': 0x69,
  'NumpadAdd': 0x6B, 'NumpadSubtract': 0x6D,
  'NumpadMultiply': 0x6A, 'NumpadDivide': 0x6F,
  'NumpadDecimal': 0x6E,
  // Note: NumpadEnter maps to the same VK_RETURN (0x0D) as the main Enter key.
  // GetAsyncKeyState cannot distinguish between them — both report the same state.
  // If you need to separate numpad Enter from main Enter, a low-level keyboard
  // hook (SetWindowsHookEx + WH_KEYBOARD_LL) with scan code checking is required.
  'NumpadEnter': 0x0D,
};

// ── Application state ──
let mainWindow = null;
let tray = null;

// Current shortcut configuration (synced from renderer via sync-settings IPC).
// Defaults match the requirements: PTT = Space, Mute = M, Pause = B.
// The renderer sends updated settings whenever the user changes keybinds.
const shortcuts = {
  ptt:   { enabled: false, key: 'Space' },
  mute:  { enabled: false, key: 'KeyM' },
  pause: { enabled: false, key: 'KeyB' },
};

// ── Hotkey state tracking ──
// pttActive    – whether PTT is currently engaged (key held down)
// firedToggles – toggle shortcuts that have already fired for the current press
//                (prevents repeat-firing while a key is held down)
let   pttActive    = false;
const firedToggles = new Set();

// ── Hotkey Polling System ──
// Polls GetAsyncKeyState every 10ms to detect global key state changes.
// This provides ~10ms latency which is imperceptible for voice communication.
// The polling approach was chosen over hooks/RegisterHotKey because:
// - It doesn't consume key events (other apps still receive them)
// - It detects both key press and release (essential for PTT)
// - It doesn't require a message loop or hidden window
// - CPU overhead is negligible (one GetAsyncKeyState call per key per cycle)

function startHotkeys() {
  if (!user32) {
    console.warn('[Hotkey] Native API not available — global hotkeys disabled');
    console.warn('[Hotkey] In-window keyboard shortcuts still work when the app is focused.');
    return;
  }

  console.log('[Hotkey] Starting global hotkey polling (10ms interval)');

  hotkeyPollInterval = setInterval(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;

      // ── PTT (Push-to-Talk) key detection ──
      // PTT fires 'ptt-down' on the key press transition and 'ptt-up' on release.
      // This mirrors Discord's PTT behavior: hold to talk, release to stop.
      if (shortcuts.ptt.enabled) {
        const vk = CODE_TO_VK[shortcuts.ptt.key];
        if (vk != null) {
          const state = user32.GetAsyncKeyState(vk);
          // Bit 15 (0x8000) of the return value: 1 = key is currently pressed
          const pressed = !!(state & 0x8000);

          if (pressed && !pttActive) {
            pttActive = true;
            mainWindow.webContents.send('shortcut', 'ptt-down');
            console.log('[Hotkey] PTT activated (key down):', shortcuts.ptt.key);
          } else if (!pressed && pttActive) {
            pttActive = false;
            mainWindow.webContents.send('shortcut', 'ptt-up');
            console.log('[Hotkey] PTT deactivated (key up):', shortcuts.ptt.key);
          }
        }
      }

      // ── Mute toggle key detection ──
      // Fires 'toggle-mute' once per key press. The firedToggles set prevents
      // repeat-firing while the key is held down. Resets when the key is released
      // so the next press fires the toggle again.
      if (shortcuts.mute.enabled) {
        const vk = CODE_TO_VK[shortcuts.mute.key];
        if (vk != null) {
          const state = user32.GetAsyncKeyState(vk);
          const pressed = !!(state & 0x8000);

          if (pressed && !firedToggles.has('mute')) {
            firedToggles.add('mute');
            mainWindow.webContents.send('shortcut', 'toggle-mute');
            console.log('[Hotkey] Mute toggled:', shortcuts.mute.key);
          } else if (!pressed && firedToggles.has('mute')) {
            firedToggles.delete('mute');
          }
        }
      }

      // ── Pause toggle key detection ──
      // Fires 'toggle-pause' once per key press. Same one-shot logic as mute.
      if (shortcuts.pause.enabled) {
        const vk = CODE_TO_VK[shortcuts.pause.key];
        if (vk != null) {
          const state = user32.GetAsyncKeyState(vk);
          const pressed = !!(state & 0x8000);

          if (pressed && !firedToggles.has('pause')) {
            firedToggles.add('pause');
            mainWindow.webContents.send('shortcut', 'toggle-pause');
            console.log('[Hotkey] Pause toggled:', shortcuts.pause.key);
          } else if (!pressed && firedToggles.has('pause')) {
            firedToggles.delete('pause');
          }
        }
      }
    } catch (err) {
      // Catch all errors to prevent the app from crashing if a native API call fails.
      console.error('[Hotkey] Poll error:', err.message);
    }
  }, 10);
}

// Stops the hotkey polling interval — called on app quit for clean shutdown.
function stopHotkeys() {
  if (hotkeyPollInterval) {
    clearInterval(hotkeyPollInterval);
    hotkeyPollInterval = null;
    console.log('[Hotkey] Global hotkey polling stopped');
  }
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
// Called when settings change to ensure clean transition between key mappings.
function resetHotkeyState() {
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
  stopHotkeys();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
