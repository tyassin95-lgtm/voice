// ── Stream Engine ──
// All WebRTC logic for screen sharing (streaming & watching)
import * as S from './state.js';
import { socket } from './socket-client.js';
import { notify } from './utils.js';
import { renderMainPanel, updateScreenShareBtn } from './ui-controller.js';
import { esc } from './utils.js';

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
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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

  // Add screen share tracks to the connection
  S.screenStream.getTracks().forEach(track => {
    pc.addTrack(track, S.screenStream);
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
    streamerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    return;
  }
  // If we are the watcher and fromId is the streamer
  if (S.watchPeerConnection && S.watchingStreamerId === fromId) {
    S.watchPeerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

export function stopWatchingStream() {
  if (S.watchPeerConnection) {
    try { S.watchPeerConnection.close(); } catch (e) { /* ignore */ }
    S.setWatchPeerConnection(null);
  }
  S.setWatchingStreamerId(null);
  removeStreamViewer();
}

// ───────────────────── Viewer UI ─────────────────────

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
        <button class="stream-viewer-close" id="stream-viewer-close-btn">✕</button>
      </div>
      <video id="stream-viewer-video" autoplay playsinline></video>
    </div>
  `;

  document.body.appendChild(overlay);

  const video = document.getElementById('stream-viewer-video');
  video.srcObject = mediaStream;

  document.getElementById('stream-viewer-close-btn').onclick = () => stopWatchingStream();
}

function removeStreamViewer() {
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
