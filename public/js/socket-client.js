// ── Socket.IO Client ──
// All socket.on listeners and emission wrappers
import * as S from './state.js';
import { notify } from './utils.js';
import { handleAudioFrom, removePeerPlayer } from './audio-engine.js';
import {
  renderSidebar, renderMainPanel, updateMyCard, updateRoleBadge,
  updateLatencyDisplay, updateBcPauseBtn, renderMemberSidebar
} from './ui-controller.js';
import {
  handleWatchRequest, handleStreamOffer, handleStreamAnswer,
  handleStreamIce, onStreamEnded
} from './stream-engine.js';
import { playSound } from './utils.js';

export const socket = io({
  transports: ['websocket', 'polling'],
  path: '/voice/socket.io',
  perMessageDeflate: false
});

// ── Audio relay listener ──
socket.on('audio-from', handleAudioFrom);

// ── Server muted ──
socket.on('server-muted', ({ muted, by }) => {
  S.setServerMutedMe(muted);
  if (muted) {
    if (S.localStream) S.localStream.getAudioTracks().forEach(t => t.enabled = false);
    notify(`🔕 You have been server muted by ${by}`, 'warn');
  } else {
    if (S.localStream && !S.isMuted && !S.settings.pushToTalk && !S.settings.pttTouch) S.localStream.getAudioTracks().forEach(t => t.enabled = true);
    notify(`🔊 Server mute removed by ${by}`, 'success');
  }
  updateMyCard();
});

socket.on('force-disconnect', ({ by }) => {
  notify(`You were disconnected by admin ${by}`, 'error');
  setTimeout(() => { window.location.reload(); }, 2000);
});

socket.on('admin-moved', ({ by, toPartyId }) => {
  notify(`Admin ${by} moved you to Party ${toPartyId}`, 'warn');
  Object.keys(S.peerPlayers).forEach(removePeerPlayer);
  S.setCurrentParty(toPartyId);
  renderSidebar();
  renderMainPanel();
});

// ── Role-based admin events ──
socket.on('role-admin-granted', ({ role }) => {
  S.setMyRole(role);
  S.setIsAdmin(true);
  document.getElementById('broadcaster-toggle').style.display = '';
  updateRoleBadge();
  notify('⚡ Admin powers activated (role: ' + role + ')', 'success');
  renderMainPanel();
});

socket.on('role-admin-revoked', () => {
  S.setMyRole('user');
  S.setIsAdmin(false);
  document.getElementById('broadcaster-toggle').style.display = 'none';
  updateRoleBadge();
  if (S.isBroadcaster) {
    S.setIsBroadcaster(false);
    document.getElementById('broadcaster-toggle').classList.remove('active-red');
    socket.emit('set-broadcaster', { isBroadcaster: false });
  }
  notify('Admin privileges have been revoked by the owner', 'warn');
  renderMainPanel();
});

// ── Connection events ──
socket.on('connect', () => {
  document.getElementById('status-dot').className    = 'status-dot connected';
  document.getElementById('status-text').textContent = 'Connected';
  if (S.myUsername) {
    socket.emit('join', { username: S.myUsername });
    if (S.currentParty) socket.emit('join-party', { partyId: S.currentParty });
    if (S.isBroadcaster) socket.emit('set-broadcaster', { isBroadcaster: true, targets: S.bcTargets, paused: S.bcPaused });
    if (S.isAdmin) {
      // On reconnect, role-based admins will get auto-granted via 'join' handler
      if (S.myRole !== 'admin' && S.myRole !== 'owner') {
        S.setIsAdmin(false);
        document.getElementById('broadcaster-toggle').style.display = 'none';
        notify('Reconnected — re-enter owner code if needed', 'warn');
      }
    }
    if (S.isMuted)    socket.emit('set-self-muted',    { muted: true });
    if (S.isDeafened) socket.emit('set-self-deafened', { deafened: true });
  }
});

socket.on('disconnect', () => {
  document.getElementById('status-dot').className   = 'status-dot disconnected';
  document.getElementById('status-text').textContent = 'Disconnected…';
});

socket.on('init', ({ partyList, memberList }) => {
  const pd = {};
  Object.entries(partyList).forEach(([id,m]) => pd[parseInt(id)] = m);
  S.setPartyData(pd);
  if (memberList) { S.setMemberList(memberList); renderMemberSidebar(); }
  renderSidebar();
});

socket.on('party-update', (partyList) => {
  const pd = {};
  Object.entries(partyList).forEach(([id,m]) => pd[parseInt(id)] = m);
  S.setPartyData(pd);
  renderSidebar();
  if (S.currentParty) renderMainPanel();
});

socket.on('member-list', (memberList) => {
  S.setMemberList(memberList);
  renderMemberSidebar();
});

socket.on('party-peers',      () => renderMainPanel());
socket.on('peer-joined',      () => { playSound('join'); renderMainPanel(); });
socket.on('peer-left', ({ socketId }) => { delete S.peerLatency[socketId]; removePeerPlayer(socketId); playSound('leave'); renderMainPanel(); });
socket.on('broadcaster-left', () => renderMainPanel());
socket.on('broadcaster-paused', ({ socketId, paused }) => renderMainPanel());
socket.on('broadcaster-joined', ({ socketId, username }) => {
  if (socketId === socket.id) return;
  notify(`📡 ${username} is now broadcasting`);
  renderMainPanel();
});

// ── Screen share signaling ──
socket.on('stream-available', ({ streamerId, streamerName }) => {
  notify(`🖥️ ${streamerName} started screen sharing`);
  renderMainPanel();
});

socket.on('stream-ended', ({ streamerId }) => {
  onStreamEnded({ streamerId });
});

socket.on('stream-watch-request', (data) => {
  handleWatchRequest(data);
});

socket.on('stream-offer', (data) => {
  handleStreamOffer(data);
});

socket.on('stream-answer', (data) => {
  handleStreamAnswer(data);
});

socket.on('stream-ice', (data) => {
  handleStreamIce(data);
});

// ── Latency measurement ──
socket.on('latency-update', ({ socketId, latency }) => {
  S.peerLatency[socketId] = latency;
  updateLatencyDisplay();
});

export function startPingLoop() {
  if (S.pingInterval) return;
  measurePing();
  S.setPingInterval(setInterval(measurePing, 3000));
}

export function stopPingLoop() {
  if (S.pingInterval) { clearInterval(S.pingInterval); S.setPingInterval(null); }
  S.setMyLatency(null);
}

function measurePing() {
  const t0 = performance.now();
  socket.emit('ping-check', () => {
    S.setMyLatency(Math.round(performance.now() - t0));
    socket.emit('latency-report', { latency: S.myLatency });
    updateLatencyDisplay();
  });
}
