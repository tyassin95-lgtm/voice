# Global Hotkey Setup — Windows Native API

GuildVoice Desktop uses native Windows API calls (`user32.dll → GetAsyncKeyState`)
via [ffi-napi](https://github.com/nicedoc/ffi-napi) to provide true global
push-to-talk and toggle hotkeys that work even when the app is unfocused or
minimized — exactly like Discord.

## Dependencies

The following npm packages are required for the native Windows API integration:

| Package            | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `ffi-napi`         | Foreign Function Interface — calls native DLL functions |
| `ref-napi`         | Pointer/type system for ffi-napi                        |
| `ref-struct-napi`  | C struct definitions (available for advanced Win32 APIs) |

## Installation

```bash
cd desktop-app

# Install all dependencies (includes ffi-napi, ref-napi, ref-struct-napi)
npm install

# Rebuild native modules for your Electron version
npx electron-rebuild
```

### Troubleshooting native module builds

`ffi-napi` and `ref-napi` contain native C++ code that must be compiled for
your specific Node.js / Electron version. If `npm install` or
`electron-rebuild` fails:

1. **Install Windows Build Tools** (if not already present):
   ```bash
   npm install --global windows-build-tools
   ```
   Or install Visual Studio Build Tools with the **Desktop development with C++** workload.

2. **Set the correct Electron version** for `node-gyp`:
   ```bash
   npx electron-rebuild --version <your-electron-version>
   ```

3. **Use the matching architecture** (x64 or arm64):
   ```bash
   npx electron-rebuild --arch x64
   ```

## Running

```bash
cd desktop-app
npm start
```

The app will load the GuildVoice web UI and activate global hotkey polling.
Check the console for `[Hotkey]` log messages confirming the native API loaded.

## Default Hotkeys

| Action           | Default Key | IPC Channel      | Behavior                         |
| ---------------- | ----------- | ---------------- | -------------------------------- |
| Push-to-Talk     | `Space`     | `ptt-down/up`    | Hold to talk, release to stop    |
| Toggle Mute      | `M`         | `toggle-mute`    | One press to toggle, auto-reset  |
| Toggle Pause     | `B`         | `toggle-pause`   | One press to toggle, auto-reset  |

Keys are configured in the app's Voice & Video settings panel. The renderer
syncs keybind changes to the main process via the `sync-settings` IPC channel.

## How It Works

1. **Main process** (`main.js`) loads `user32.dll` via `ffi-napi` and polls
   `GetAsyncKeyState` every 10 ms to detect global key state changes.
2. On key transitions, the main process sends IPC messages (`ptt-down`,
   `ptt-up`, `toggle-mute`, `toggle-pause`) to the renderer.
3. **Preload script** (`preload.js`) exposes a safe `window.electronAPI`
   bridge via `contextBridge` for the renderer to receive these events.
4. **Renderer** (`public/js/app.js`) reacts to the events by toggling
   mute, controlling PTT transmission, etc.

## Architecture Diagram

```
┌─────────────────────────────┐
│     Renderer Process        │
│  (public/js/app.js)         │
│                             │
│  electronAPI.onShortcut()   │◄──── IPC ('shortcut' channel)
│  electronAPI.syncSettings() │────► IPC ('sync-settings' channel)
└─────────────────────────────┘
            ▲  │
            │  ▼
┌─────────────────────────────┐
│     Preload Bridge          │
│  (preload.js)               │
│  contextBridge.exposeIn...  │
└─────────────────────────────┘
            ▲  │
            │  ▼
┌─────────────────────────────┐
│     Main Process            │
│  (main.js)                  │
│                             │
│  user32.GetAsyncKeyState()  │◄──── Windows API (user32.dll)
│  setInterval(poll, 10ms)    │
└─────────────────────────────┘
```

## Platform Support

This hotkey implementation is **Windows-only**. On other platforms:
- The native API loading is skipped gracefully (no crash).
- Global hotkeys are not available.
- In-window keyboard shortcuts still work when the app is focused
  (handled by the renderer's `keydown`/`keyup` event listeners).
