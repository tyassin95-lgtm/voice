// ── Start Screen Stream ──
// Abstraction for obtaining a screen-capture MediaStream.
// In Electron: shows a custom screen picker via desktopCapturer.
// In a regular browser: falls back to the native getDisplayMedia picker.

import { showScreenPicker } from './screenPicker.js';

/**
 * Acquire a screen-capture MediaStream.
 * Automatically detects the runtime environment:
 *  - Electron → custom picker + getUserMedia with chromeMediaSource constraints
 *  - Browser  → native getDisplayMedia picker
 * @returns {Promise<MediaStream>}
 */
export async function startScreenStream() {
  if (window.electronAPI) {
    // ── Electron path ──
    const source = await showScreenPicker();

    // Electron requires the legacy mandatory constraint syntax for
    // chromeMediaSource / chromeMediaSourceId.
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      },
    });
  }

  // ── Browser path ──
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { max: 30 },
    },
    audio: true,
  });
}
