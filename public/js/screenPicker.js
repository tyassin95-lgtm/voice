// ── Screen Picker ──
// Custom source picker for Electron desktop screen sharing.
// Calls window.electronAPI.getSources() and displays a fullscreen overlay
// with thumbnails for each available screen/window.

/**
 * Show the custom screen/window picker overlay.
 * Resolves with the selected source object { id, name, thumbnail }.
 * Rejects if no sources are available or the user cancels.
 * @returns {Promise<{id: string, name: string, thumbnail: string}>}
 */
export function showScreenPicker() {
  return new Promise((resolve, reject) => {
    window.electronAPI.getSources().then((sources) => {
      if (!sources || sources.length === 0) {
        reject(new Error('No desktop sources found'));
        return;
      }

      // ── Build overlay ──
      const overlay = document.createElement('div');
      overlay.id = 'screen-picker-overlay';
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.75); display: flex;
        align-items: center; justify-content: center;
      `;

      const modal = document.createElement('div');
      modal.style.cssText = `
        background: #1e1f22; border-radius: 12px; padding: 24px;
        max-width: 820px; width: 90vw; max-height: 80vh;
        overflow-y: auto; color: #dcddde;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      `;

      const title = document.createElement('h2');
      title.textContent = 'Choose what to share';
      title.style.cssText = 'margin: 0 0 16px; font-size: 18px; font-weight: 600; color: #fff;';

      const grid = document.createElement('div');
      grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
      `;

      function cleanup() {
        overlay.remove();
      }

      sources.forEach((source) => {
        const card = document.createElement('div');
        card.style.cssText = `
          background: #2b2d31; border-radius: 8px; cursor: pointer;
          overflow: hidden; border: 2px solid transparent;
          transition: border-color 0.15s, transform 0.15s;
        `;
        card.addEventListener('mouseenter', () => {
          card.style.borderColor = '#5865f2';
          card.style.transform = 'scale(1.03)';
        });
        card.addEventListener('mouseleave', () => {
          card.style.borderColor = 'transparent';
          card.style.transform = 'scale(1)';
        });

        const img = document.createElement('img');
        img.src = source.thumbnail;
        img.alt = source.name;
        img.style.cssText = 'width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block;';

        const label = document.createElement('div');
        label.textContent = source.name;
        label.style.cssText = `
          padding: 8px 10px; font-size: 13px; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; color: #b5bac1;
        `;

        card.appendChild(img);
        card.appendChild(label);

        card.addEventListener('click', () => {
          cleanup();
          resolve(source);
        });

        grid.appendChild(card);
      });

      // Cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = `
        display: block; margin: 16px auto 0; padding: 8px 24px;
        background: #4e5058; color: #fff; border: none;
        border-radius: 6px; font-size: 14px; cursor: pointer;
      `;
      cancelBtn.addEventListener('click', () => {
        cleanup();
        reject(new Error('Screen picker cancelled'));
      });

      // Close on overlay background click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          cleanup();
          reject(new Error('Screen picker cancelled'));
        }
      });

      modal.appendChild(title);
      modal.appendChild(grid);
      modal.appendChild(cancelBtn);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    }).catch(reject);
  });
}
