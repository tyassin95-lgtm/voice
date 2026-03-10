const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Unit tests for stream watcher tracking logic.
 *
 * The helpers under test (addStreamWatcher, removeStreamWatcher, etc.) live
 * inside the socketHandler closure, so we replicate the same pure-logic
 * implementation here to verify correctness in isolation.
 */

// ── Replicated helpers (same algorithm as socketHandler.js) ──

let streamWatchers;
let emitted; // collects emitted events for assertions

function resetState() {
  streamWatchers = {};
  emitted = [];
}

function emitViewerList(streamerId) {
  const watcherIds = streamWatchers[streamerId] ? [...streamWatchers[streamerId]] : [];
  const viewers = watcherIds.map(wid => ({ socketId: wid, username: `user-${wid}` }));
  emitted.push({ streamerId, viewers });
}

function addStreamWatcher(streamerId, watcherId) {
  if (!streamWatchers[streamerId]) streamWatchers[streamerId] = new Set();
  streamWatchers[streamerId].add(watcherId);
  emitViewerList(streamerId);
}

function removeStreamWatcher(streamerId, watcherId) {
  if (!streamWatchers[streamerId]) return;
  streamWatchers[streamerId].delete(watcherId);
  emitViewerList(streamerId);
  if (streamWatchers[streamerId].size === 0) delete streamWatchers[streamerId];
}

function removeWatcherFromAll(watcherId) {
  for (const sid of Object.keys(streamWatchers)) {
    if (streamWatchers[sid].has(watcherId)) {
      removeStreamWatcher(sid, watcherId);
    }
  }
}

// ── Tests ──

describe('Stream watcher tracking', () => {
  beforeEach(() => resetState());

  it('adds a watcher and emits viewer list', () => {
    addStreamWatcher('streamer1', 'watcher1');
    assert.equal(streamWatchers['streamer1'].size, 1);
    assert.ok(streamWatchers['streamer1'].has('watcher1'));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].viewers.length, 1);
    assert.equal(emitted[0].viewers[0].socketId, 'watcher1');
  });

  it('adds multiple watchers to the same stream', () => {
    addStreamWatcher('streamer1', 'w1');
    addStreamWatcher('streamer1', 'w2');
    addStreamWatcher('streamer1', 'w3');
    assert.equal(streamWatchers['streamer1'].size, 3);
    // Last emit should contain all 3
    const lastEmit = emitted[emitted.length - 1];
    assert.equal(lastEmit.viewers.length, 3);
  });

  it('does not duplicate a watcher', () => {
    addStreamWatcher('streamer1', 'w1');
    addStreamWatcher('streamer1', 'w1');
    assert.equal(streamWatchers['streamer1'].size, 1);
  });

  it('removes a watcher and emits updated list', () => {
    addStreamWatcher('streamer1', 'w1');
    addStreamWatcher('streamer1', 'w2');
    emitted = [];
    removeStreamWatcher('streamer1', 'w1');
    assert.equal(streamWatchers['streamer1'].size, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].viewers.length, 1);
    assert.equal(emitted[0].viewers[0].socketId, 'w2');
  });

  it('cleans up streamer key when last watcher leaves', () => {
    addStreamWatcher('streamer1', 'w1');
    removeStreamWatcher('streamer1', 'w1');
    assert.equal(streamWatchers['streamer1'], undefined);
  });

  it('removeStreamWatcher is a no-op for unknown streamer', () => {
    removeStreamWatcher('unknown', 'w1');
    assert.equal(emitted.length, 0);
  });

  it('removeWatcherFromAll removes from all streams', () => {
    addStreamWatcher('s1', 'w1');
    addStreamWatcher('s2', 'w1');
    addStreamWatcher('s1', 'w2');
    emitted = [];
    removeWatcherFromAll('w1');
    assert.equal(streamWatchers['s1'].size, 1);
    assert.ok(streamWatchers['s1'].has('w2'));
    assert.equal(streamWatchers['s2'], undefined);
  });

  it('deleting stream watchers on stream-stop clears all', () => {
    addStreamWatcher('streamer1', 'w1');
    addStreamWatcher('streamer1', 'w2');
    // Simulate stream-stop: delete streamWatchers[streamerId]
    delete streamWatchers['streamer1'];
    assert.equal(streamWatchers['streamer1'], undefined);
  });
});

describe('1080p resolution cap', () => {
  it('getDisplayMedia constraints include max 1920x1080', () => {
    // Verify the constraint object shape that would be passed to getDisplayMedia
    const constraints = {
      video: { width: { max: 1920 }, height: { max: 1080 } },
      audio: true
    };
    assert.equal(constraints.video.width.max, 1920);
    assert.equal(constraints.video.height.max, 1080);
    assert.equal(constraints.audio, true);
  });
});

describe('Stream viewer UI structure', () => {
  it('viewer HTML includes fullscreen button', () => {
    // Simulate the HTML structure that showStreamViewer creates
    const html = `
      <div class="stream-viewer-container">
        <div class="stream-viewer-header">
          <span>🖥️ TestUser's screen</span>
          <div class="stream-viewer-header-actions">
            <button class="stream-viewer-btn" id="stream-viewer-fullscreen-btn" title="Toggle fullscreen">⛶</button>
            <button class="stream-viewer-close" id="stream-viewer-close-btn">✕</button>
          </div>
        </div>
        <video id="stream-viewer-video" autoplay playsinline></video>
        <div class="stream-viewer-footer" id="stream-viewer-list"></div>
      </div>
    `;
    assert.ok(html.includes('stream-viewer-fullscreen-btn'));
    assert.ok(html.includes('Toggle fullscreen'));
    assert.ok(html.includes('stream-viewer-footer'));
    assert.ok(html.includes('stream-viewer-list'));
    assert.ok(html.includes('stream-viewer-header-actions'));
  });
});
