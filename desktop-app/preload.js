// ── GuildVoice Desktop – Preload Bridge ──
// Exposes a secure Electron API to the renderer via contextBridge.
// NO script injection – all integration is through contextBridge + IPC.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Sync a keybind setting to the main process.
   * Called by the frontend whenever the user updates a keybind.
   * @param {'ptt'|'mute'|'pause'} type  - Shortcut type
   * @param {boolean}               enabled - Whether the shortcut is enabled
   * @param {string}                key     - Keyboard event code (e.g. 'KeyV')
   */
  syncSettings(type, enabled, key) {
    ipcRenderer.send('sync-settings', { type, enabled, key });
  },

  /**
   * Listen for global shortcut events from the main process.
   * @param {'ptt-down'|'ptt-up'|'toggle-mute'|'toggle-pause'} channel
   * @param {Function} callback
   * @returns {Function} cleanup function to remove the listener
   */
  onShortcut(channel, callback) {
    const validChannels = ['ptt-down', 'ptt-up', 'toggle-mute', 'toggle-pause'];
    if (!validChannels.includes(channel)) return () => {};

    const handler = (_event, shortcutChannel) => {
      if (shortcutChannel === channel) {
        callback();
      }
    };

    ipcRenderer.on('shortcut', handler);

    // Return a cleanup function
    return () => {
      ipcRenderer.removeListener('shortcut', handler);
    };
  },

  /**
   * Get available desktop sources for screen sharing.
   * Returns an array of { id, name, thumbnail } objects.
   * @returns {Promise<Array<{id: string, name: string, thumbnail: string}>>}
   */
  getSources() {
    return ipcRenderer.invoke('get-desktop-sources');
  },

  /**
   * Listen for auto-updater status events from the main process.
   * @param {Function} callback - Receives { event, data }
   * @returns {Function} cleanup function to remove the listener
   */
  onUpdateStatus(callback) {
    const handler = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on('update-status', handler);

    // Return a cleanup function
    return () => {
      ipcRenderer.removeListener('update-status', handler);
    };
  },
});
