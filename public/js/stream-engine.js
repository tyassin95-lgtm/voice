// ── Stream Engine ──
// All WebRTC logic for screen sharing (streaming & watching)
import * as S from './state.js';
import { socket } from './socket-client.js';
import { notify } from './utils.js';
import { renderMainPanel, updateScreenShareBtn } from './ui-controller.js';
import { esc } from './utils.js';
import { startScreenStream } from './startScreenStream.js';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ───────────────────── Streamer Functions ─────────────────────

export async function startScreenShare() {
  if (!S.currentParty) {
    notify('Join a party first to share your screen', 'warn');
    return;
  }
  try {
    const stream = await startScreenStream();

    S.setScreenStream(stream);
    S.setIsStreaming(true);
    socket.emit('stream-start');
    updateScreenShareBtn();

    // Auto-stop when the user clicks "Stop sharing" in the browser
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => stopScreenShare();
    }
  } catch (e) {
    // User cancelled the screen picker
    console.log('[Stream] Screen share cancelled or failed:', e.message);
  }
}

export function stopScreenShare() {
  if (S.screenStream) {
    S.screenStream.getTracks().forEach(t => t.stop());
    S.setScreenStream(null);
  }
  // Close all peer connections to watchers
  Object.values(S.streamPeerConnections).forEach(pc => {
    try { pc.close(); } catch (e) { /* ignore */ }
  });
  S.setStreamPeerConnections({});
  S.setIsStreaming(false);
  socket.emit('stream-stop');
  updateScreenShareBtn();
}

export function handleWatchRequest({ watcherId }) {
  if (!S.screenStream || !S.isStreaming) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);

  S.screenStream.getTracks().forEach(track => {
    const sender = pc.addTrack(track, S.screenStream);
    
    // If it's the video track, forcefully limit the bitrate
    if (track.kind === 'video') {
      const parameters = sender.getParameters();
      if (!parameters.encodings) {
        parameters.encodings = [{}];
      }
      // Cap at 1.5 Mbps per watcher
      parameters.encodings[0].maxBitrate = 1500000; 
      sender.setParameters(parameters).catch(e => console.error(e));
    }
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('stream-ice', { targetId: watcherId, candidate: e.candidate });
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('stream-offer', { watcherId, offer: pc.localDescription });
    } catch (e) {
      console.error('[Stream] Failed to create offer:', e);
    }
  };

  const conns = { ...S.streamPeerConnections };
  conns[watcherId] = pc;
  S.setStreamPeerConnections(conns);
}

// ───────────────────── Watcher Functions ─────────────────────

export function requestWatchStream(streamerId) {
  if (!S.currentParty) return;
  if (S.watchingStreamerId === streamerId) return; // already watching this streamer
  if (S.watchingStreamerId) stopWatchingStream();
  S.setWatchingStreamerId(streamerId);
  socket.emit('stream-watch-request', { streamerId });
}

export function handleStreamOffer({ streamerId, offer }) {
  if (S.watchingStreamerId !== streamerId) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  S.setWatchPeerConnection(pc);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('stream-ice', { targetId: streamerId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    showStreamViewer(streamerId, e.streams[0]);
  };

  (async () => {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('stream-answer', { streamerId, answer: pc.localDescription });
    } catch (e) {
      console.error('[Stream] Failed to handle offer:', e);
    }
  })();
}

export function handleStreamAnswer({ watcherId, answer }) {
  const pc = S.streamPeerConnections[watcherId];
  if (!pc) return;
  pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(e => {
    console.error('[Stream] Failed to set remote answer:', e);
  });
}

export function handleStreamIce({ fromId, candidate }) {
  // Route ICE to the correct peer connection
  // If we are the streamer and fromId is a watcher
  const streamerPc = S.streamPeerConnections[fromId];
  if (streamerPc) {
    streamerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {
      console.warn('[Stream] ICE candidate error (streamer):', e);
    });
    return;
  }
  // If we are the watcher and fromId is the streamer
  if (S.watchPeerConnection && S.watchingStreamerId === fromId) {
    S.watchPeerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {
      console.warn('[Stream] ICE candidate error (watcher):', e);
    });
  }
}

export function stopWatchingStream() {
  const prevStreamerId = S.watchingStreamerId;
  if (S.watchPeerConnection) {
    try { S.watchPeerConnection.close(); } catch (e) { /* ignore */ }
    S.setWatchPeerConnection(null);
  }
  S.setWatchingStreamerId(null);
  S.setStreamViewers([]);
  if (prevStreamerId) socket.emit('stream-watch-stop', { streamerId: prevStreamerId });
  // Exit fullscreen if active
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  removeStreamViewer();
}

// ───────────────────── Viewer UI ─────────────────────

function toggleFullscreen() {
  const container = document.querySelector('.stream-viewer-container');
  if (!container) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    container.requestFullscreen().catch(() => {});
  }
}

function renderViewerList() {
  const el = document.getElementById('stream-viewer-list');
  if (!el) return;
  const viewers = S.streamViewers;
  if (viewers.length === 0) {
    el.innerHTML = '<span class="stream-viewer-count">No viewers</span>';
    return;
  }
  const label = viewers.length === 1 ? '1 viewer' : `${viewers.length} viewers`;
  const names = viewers.map(v => `<span class="stream-viewer-name">${esc(v.username)}</span>`).join('');
  el.innerHTML = `<span class="stream-viewer-count">👁️ ${label}:</span>${names}`;
}

export function updateStreamViewers(streamerId, viewers) {
  S.setStreamViewers(viewers);
  renderViewerList();
}

function showStreamViewer(streamerId, mediaStream) {
  removeStreamViewer(); // Clean up any existing viewer

  // Find streamer name from party data
  let streamerName = 'Unknown';
  if (S.currentParty && S.partyData[S.currentParty]) {
    const member = S.partyData[S.currentParty].find(m => m.socketId === streamerId);
    if (member) streamerName = member.username;
  }

  const overlay = document.createElement('div');
  overlay.id = 'stream-viewer-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) stopWatchingStream(); };

  overlay.innerHTML = `
    <div class="stream-viewer-container">
      <div class="stream-viewer-header">
        <span>🖥️ ${esc(streamerName)}'s screen</span>
        <div class="stream-viewer-header-actions">
          <button class="stream-viewer-btn" id="stream-viewer-fullscreen-btn" title="Toggle fullscreen">⛶</button>
          <button class="stream-viewer-close" id="stream-viewer-close-btn">✕</button>
        </div>
      </div>
      <video id="stream-viewer-video" autoplay playsinline></video>
      <div class="stream-viewer-footer" id="stream-viewer-list"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const video = document.getElementById('stream-viewer-video');
  video.srcObject = mediaStream;

  document.getElementById('stream-viewer-close-btn').onclick = () => stopWatchingStream();
  document.getElementById('stream-viewer-fullscreen-btn').onclick = () => toggleFullscreen();

  // Update fullscreen button icon on fullscreen change
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Render current viewer list
  renderViewerList();
}

function onFullscreenChange() {
  const btn = document.getElementById('stream-viewer-fullscreen-btn');
  if (!btn) {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    return;
  }
  btn.textContent = document.fullscreenElement ? '⊡' : '⛶';
  btn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Toggle fullscreen';
}

function removeStreamViewer() {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  const overlay = document.getElementById('stream-viewer-overlay');
  if (overlay) overlay.remove();
}

// ───────────────────── Stream Ended (remote) ─────────────────────

export function onStreamEnded({ streamerId }) {
  // If we were watching this streamer, stop
  if (S.watchingStreamerId === streamerId) {
    stopWatchingStream();
    notify('Stream has ended', 'warn');
  }
  // If we were streaming and a watcher's connection needs cleanup, handled by stopScreenShare
  renderMainPanel();
}
