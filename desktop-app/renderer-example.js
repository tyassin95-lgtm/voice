// ── GuildVoice Desktop – Renderer Example ──
// This file demonstrates how the renderer process listens for global hotkey
// events forwarded from the Electron main process via the contextBridge preload API.
//
// In the actual app, this logic lives in public/js/app.js (lines 162–192).
// This standalone example is provided for reference and testing.
//
// The preload.js script exposes window.electronAPI with:
//   - syncSettings(type, enabled, key) – send keybind config to main process
//   - onShortcut(channel, callback)    – listen for shortcut events
//
// The main process sends these shortcut channels:
//   'ptt-down'      – Push-to-Talk key was pressed (start transmitting)
//   'ptt-up'        – Push-to-Talk key was released (stop transmitting)
//   'toggle-mute'   – Mute toggle key was pressed (toggle mic mute)
//   'toggle-pause'  – Pause toggle key was pressed (toggle broadcast pause)

// ── Guard: Only run when inside Electron ──
if (window.electronAPI) {

  // ── 1. Sync initial keybind settings to the main process ──
  // These tell the main process which keys to watch and whether each shortcut
  // is enabled. Call syncSettings again whenever the user changes a keybind.
  window.electronAPI.syncSettings('ptt',   true,  'Space');  // PTT = Space
  window.electronAPI.syncSettings('mute',  true,  'KeyM');   // Mute = M
  window.electronAPI.syncSettings('pause', true,  'KeyB');   // Pause = B

  // ── 2. Listen for Push-to-Talk events ──
  // PTT fires on key press (ptt-down) and key release (ptt-up).
  // Use these to start/stop audio transmission.
  window.electronAPI.onShortcut('ptt-down', () => {
    console.log('[Renderer] PTT activated — start transmitting audio');
    // Example: enable microphone stream
    // setPTTTransmit(true);
  });

  window.electronAPI.onShortcut('ptt-up', () => {
    console.log('[Renderer] PTT deactivated — stop transmitting audio');
    // Example: disable microphone stream
    // setPTTTransmit(false);
  });

  // ── 3. Listen for Mute toggle events ──
  // Fires once per key press. Use this to toggle the microphone mute state.
  window.electronAPI.onShortcut('toggle-mute', () => {
    console.log('[Renderer] Mute toggled');
    // Example: toggle mute state
    // toggleMute();
  });

  // ── 4. Listen for Pause toggle events ──
  // Fires once per key press. Use this to toggle the broadcast pause state.
  window.electronAPI.onShortcut('toggle-pause', () => {
    console.log('[Renderer] Broadcast pause toggled');
    // Example: toggle broadcast pause
    // onBroadcastPauseToggle();
  });

  // ── 5. Updating keybinds at runtime ──
  // To change a keybind, call syncSettings with the new key code:
  //   window.electronAPI.syncSettings('ptt', true, 'KeyV');  // Change PTT to V
  //   window.electronAPI.syncSettings('mute', false, 'KeyM'); // Disable mute hotkey

  // ── 6. Cleanup (optional) ──
  // onShortcut returns a cleanup function to remove the listener:
  //   const cleanup = window.electronAPI.onShortcut('ptt-down', callback);
  //   cleanup(); // removes the listener

} else {
  console.log('[Renderer] Not running in Electron — global hotkeys unavailable');
  console.log('[Renderer] In-window keyboard shortcuts are still active.');
}
