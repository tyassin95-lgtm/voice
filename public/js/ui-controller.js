// ── UI Controller ──
// DOM manipulation, modal toggling, party list rendering
import * as S from './state.js';
import { socket, startPingLoop, stopPingLoop } from './socket-client.js';
import { esc, setErr, notify, playSound, latencyClass } from './utils.js';
import { initAudio, removePeerPlayer, switchMicrophone, initVAD } from './audio-engine.js';
import { startScreenShare, stopScreenShare, requestWatchStream, stopWatchingStream } from './stream-engine.js';

// Validate hex color format for safe inline style use
function safeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#5865f2'; }

// Rebuild sidebar avatar cleanly every time (avoids status dot duplication)
function syncSidebarAvatar() {
  const sidebarAvatar = document.getElementById('sidebar-avatar');
  if (!sidebarAvatar) return;
  if (S.myAvatarUrl) {
    sidebarAvatar.innerHTML = `<img src="${esc(S.myAvatarUrl)}" alt=""><span class="status-dot connected" id="status-dot"></span>`;
  } else {
    sidebarAvatar.innerHTML = `${esc(S.myUsername[0].toUpperCase())}<span class="status-dot connected" id="status-dot"></span>`;
  }
}

function updateOwnerLoginVisibility() {
  const ownerTab     = document.getElementById('settings-tab-owner');
  const ownerContent = document.getElementById('tab-owner');
  // Also clean up old owner-login-row/owner-login-content if they still exist in HTML
  const oldRow     = document.getElementById('owner-login-row');
  const oldContent = document.getElementById('owner-login-content');
  if (oldRow)     oldRow.style.display     = 'none';
  if (oldContent) oldContent.style.display = 'none';
  // Always show the dedicated owner tab (admins/owners should still be able to view it)
  if (ownerTab)    ownerTab.style.display    = '';
  if (ownerContent) ownerContent.style.display = 'none'; // tab switching handles content visibility
}

// ── Auth tab switching ──
export function switchAuthTab(tab) {
  ['login','register','guest'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('.modal-tab').forEach((el, i) => {
    el.classList.toggle('active', ['login','register','guest'][i] === tab);
  });
}

// ── Login / Register / Guest ──
export async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  if (!username || !password) return setErr('login-err', 'Fill in all fields');
  try {
    const res = await fetch('/voice/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) return setErr('login-err', 'Server error — try again');
    const data = await res.json();
    if (!data.ok) return setErr('login-err', data.error);
    S.setMyUsername(data.username);
    S.setMyPassword(password);
    S.setIsGuest(false);
    S.setMyRole(data.role || 'user');
    S.setMyAvatarUrl(data.avatarUrl || '');
    S.setMyBannerColor(data.bannerColor || '#5865f2');
    S.setMyBio(data.bio || '');
    S.setMyCustomStatus(data.customStatus || '');
    applySettings(data.settings);
    enterApp();
  } catch (e) {
    setErr('login-err', 'Could not reach server — try again');
  }
}

export async function doRegister() {
  const username = document.getElementById('reg-user').value.trim();
  const password = document.getElementById('reg-pass').value;
  const pass2    = document.getElementById('reg-pass2').value;
  if (!username || !password) return setErr('reg-err', 'Fill in all fields');
  if (password !== pass2)     return setErr('reg-err', 'Passwords do not match');
  if (password.length < 4)    return setErr('reg-err', 'Password too short (min 4 chars)');
  try {
    const res = await fetch('/voice/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) return setErr('reg-err', 'Server error — try again');
    const data = await res.json();
    if (!data.ok) return setErr('reg-err', data.error);
    S.setMyUsername(username);
    S.setMyPassword(password);
    S.setIsGuest(false);
    notify('Account created! Welcome, ' + username, 'success');
    enterApp();
  } catch (e) {
    setErr('reg-err', 'Could not reach server — try again');
  }
}

export function doGuest() {
  const name = document.getElementById('guest-name').value.trim();
  if (!name) return setErr('guest-err', 'Enter a name');
  S.setMyUsername(name);
  S.setIsGuest(true);
  enterApp();
}

export function enterApp() {
  document.getElementById('auth-modal').classList.add('hidden');
  document.getElementById('app').style.display = 'block';
  document.getElementById('settings-save-row').style.display = S.isGuest ? 'none' : 'block';
  document.getElementById('settings-sub').textContent = S.isGuest
    ? 'Guest — settings not saved'
    : `Signed in as ${S.myUsername}`;
  // Sync sidebar user panel
  syncSidebarAvatar();
  const sidebarUsername = document.getElementById('sidebar-username');
  if (sidebarUsername) sidebarUsername.textContent = S.myUsername;
  socket.emit('join', { username: S.myUsername });
  initAudio();   // initVAD is called inside initAudio after getUserMedia succeeds
  applySettingsUI();
  initPTTTouchButton();
}

export function applySettings(s) {
  if (!s) return;
  S.setSettings({ ...S.settings, ...s });
}

export function applySettingsUI() {
  document.getElementById('sens-slider').value   = S.settings.micSensitivity;
  document.getElementById('sens-val').textContent= S.settings.micSensitivity;
  updateSensitivityMode(S.settings.micSensitivity);
  document.getElementById('invol-slider').value  = S.settings.inputVolume;
  document.getElementById('invol-val').textContent = S.settings.inputVolume + '%';
  document.getElementById('toggle-mute-keybind').checked = S.settings.muteKeybind || false;
  document.getElementById('mute-key-btn').textContent    = S.settings.muteKey || 'KeyM';
  document.getElementById('mute-key-row').style.opacity       = S.settings.muteKeybind ? '1' : '0.4';
  document.getElementById('mute-key-row').style.pointerEvents = S.settings.muteKeybind ? '' : 'none';
  document.getElementById('toggle-bcpause-keybind').checked    = S.settings.bcPauseKeybind || false;
  document.getElementById('bcpause-key-btn').textContent       = S.settings.bcPauseKey || 'KeyB';
  document.getElementById('bcpause-key-row').style.opacity       = S.settings.bcPauseKeybind ? '1' : '0.4';
  document.getElementById('bcpause-key-row').style.pointerEvents = S.settings.bcPauseKeybind ? '' : 'none';
  document.getElementById('toggle-ptt').checked        = S.settings.pushToTalk;
  document.getElementById('toggle-ptt-touch').checked  = S.settings.pttTouch;
  document.getElementById('ptt-key-btn').textContent    = S.settings.pttKey;
  document.getElementById('ptt-key-row').style.opacity       = S.settings.pushToTalk ? '1' : '0.4';
  document.getElementById('ptt-key-row').style.pointerEvents = S.settings.pushToTalk ? '' : 'none';
  if (S.inputGainNode) S.inputGainNode.gain.value = S.settings.inputVolume / 100;
  const ncStored = localStorage.getItem('voice_noise_cancelation_enabled');
  if (ncStored !== null) S.settings.noiseCancelation = ncStored === 'true';
  document.getElementById('toggle-noise-cancel').checked = S.settings.noiseCancelation !== false;
  updateOwnerLoginVisibility();
}

export function openSettings() {
  document.getElementById('settings-modal').classList.remove('hidden');
  populateDeviceList();
}
export function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

export function switchSettingsTab(tabId) {
  const validTabs = ['voice-video', 'app-settings', 'owner'];
  if (!validTabs.includes(tabId)) return;
  document.querySelectorAll('.settings-tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('tab-' + tabId);
  if (target) target.style.display = '';
  const btn = document.querySelector(`.settings-tab[data-settings-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');
}

export function onSensChange(val) {
  S.settings.micSensitivity = parseInt(val);
  document.getElementById('sens-val').textContent = val;
  updateSensitivityMode(val);
  S.setVadAttackCount(0);
  S.setSmoothedEnergy(0);
  if (S.micVAD) {
    const sens      = S.settings.micSensitivity;
    const posThresh = 0.92 - (sens / 100) * 0.77;
    const negThresh = Math.max(0.10, posThresh - 0.15);
    const minFrames = sens <= 25 ? 6 : (sens <= 50 ? 4 : 3);
    S.micVAD.setOptions({ positiveSpeechThreshold: posThresh, negativeSpeechThreshold: negThresh, minSpeechFrames: minFrames });
  }
}

export function updateSensitivityMode(val) {
  const v = parseInt(val);
  const el = document.getElementById('sens-mode');
  if (!el) return;
  if (v <= 20)      { el.textContent = 'Strict';    el.style.color = 'var(--green)'; }
  else if (v <= 40) { el.textContent = 'Low';       el.style.color = 'var(--green)'; }
  else if (v <= 60) { el.textContent = 'Normal';    el.style.color = 'var(--accent2)'; }
  else if (v <= 80) { el.textContent = 'High';      el.style.color = 'var(--yellow)'; }
  else              { el.textContent = 'Sensitive';  el.style.color = 'var(--red)'; }
}

export function onInputVolChange(val) {
  S.settings.inputVolume = parseInt(val);
  document.getElementById('invol-val').textContent = val + '%';
  if (S.inputGainNode) S.inputGainNode.gain.value = val / 100;
}

export function onPttToggle() {
  S.settings.pushToTalk = document.getElementById('toggle-ptt').checked;
  document.getElementById('ptt-key-row').style.opacity       = S.settings.pushToTalk ? '1' : '0.4';
  document.getElementById('ptt-key-row').style.pointerEvents = S.settings.pushToTalk ? '' : 'none';
  if (S.settings.pushToTalk && S.localStream) {
    S.localStream.getAudioTracks().forEach(t => t.enabled = false);
  } else if (!S.settings.pushToTalk && !S.settings.pttTouch && S.localStream && !S.isMuted) {
    S.localStream.getAudioTracks().forEach(t => t.enabled = true);
  }
  updatePTTButton();
}

export function onNoiseCancelToggle() {
  S.settings.noiseCancelation = document.getElementById('toggle-noise-cancel').checked;
  localStorage.setItem('voice_noise_cancelation_enabled', S.settings.noiseCancelation);
}

/* ═══ AUDIO DEVICE SELECTION ═══ */
export async function populateDeviceList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputSelect  = document.getElementById('input-device-select');
    const outputSelect = document.getElementById('output-device-select');
    if (!inputSelect || !outputSelect) return;

    const prevInput  = inputSelect.value;
    const prevOutput = outputSelect.value;

    inputSelect.innerHTML  = '<option value="">System Default</option>';
    outputSelect.innerHTML = '<option value="">System Default</option>';

    let inputCount = 0, outputCount = 0;
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      if (d.kind === 'audioinput') {
        inputCount++;
        opt.textContent = d.label || ('Microphone ' + inputCount);
        inputSelect.appendChild(opt);
      } else if (d.kind === 'audiooutput') {
        outputCount++;
        opt.textContent = d.label || ('Speaker ' + outputCount);
        outputSelect.appendChild(opt);
      }
    });

    // Restore selection — fall back to default if saved device is gone
    if (S.selectedInputDeviceId && [...inputSelect.options].some(o => o.value === S.selectedInputDeviceId)) {
      inputSelect.value = S.selectedInputDeviceId;
    } else {
      inputSelect.value = prevInput || '';
    }
    if (S.selectedOutputDeviceId && [...outputSelect.options].some(o => o.value === S.selectedOutputDeviceId)) {
      outputSelect.value = S.selectedOutputDeviceId;
    } else {
      outputSelect.value = prevOutput || '';
    }
  } catch (e) {
    console.warn('[Devices] Could not enumerate devices:', e);
  }
}

export async function onInputDeviceChange() {
  const sel = document.getElementById('input-device-select');
  S.setSelectedInputDeviceId(sel.value);
  localStorage.setItem('voice_input_device_id', S.selectedInputDeviceId);
  if (S.localStream) await switchMicrophone(S.selectedInputDeviceId);
}

export async function onOutputDeviceChange() {
  const sel = document.getElementById('output-device-select');
  S.setSelectedOutputDeviceId(sel.value);
  localStorage.setItem('voice_output_device_id', S.selectedOutputDeviceId);
  await applyOutputDevice();
}

export async function applyOutputDevice() {
  const deviceId = S.selectedOutputDeviceId || '';
  try {
    // AudioContext.setSinkId is available in modern browsers
    if (S.playbackCtx && typeof S.playbackCtx.setSinkId === 'function') {
      await S.playbackCtx.setSinkId(deviceId);
    }
    if (S.sfxCtx && typeof S.sfxCtx.setSinkId === 'function') {
      await S.sfxCtx.setSinkId(deviceId);
    }
  } catch (e) {
    console.warn('[Devices] Could not set output device:', e);
  }
}

export function onPttTouchToggle() {
  S.settings.pttTouch = document.getElementById('toggle-ptt-touch').checked;
  if (S.settings.pttTouch && S.localStream) {
    S.localStream.getAudioTracks().forEach(t => t.enabled = false);
  } else if (!S.settings.pttTouch && !S.settings.pushToTalk && S.localStream && !S.isMuted) {
    S.localStream.getAudioTracks().forEach(t => t.enabled = true);
  }
  updatePTTButton();
}

export function startListeningPTT() {
  S.setPttListening(true);
  const btn = document.getElementById('ptt-key-btn');
  btn.textContent = 'Press a key…';
  btn.classList.add('listening');
}

export async function saveSettings() {
  if (S.isGuest || !S.myPassword) return;
  try {
    const res = await fetch('/voice/api/save-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: S.myUsername, password: S.myPassword, settings: S.settings })
    });
    if (!res.ok) return notify('Could not save settings', 'error');
    const data = await res.json();
    if (data.ok) notify('Settings saved ✓', 'success');
    else notify('Could not save settings', 'error');
  } catch (e) {
    notify('Could not reach server — settings not saved', 'error');
  }
}

export function onMuteKeybindToggle() {
  S.settings.muteKeybind = document.getElementById('toggle-mute-keybind').checked;
  document.getElementById('mute-key-row').style.opacity       = S.settings.muteKeybind ? '1' : '0.4';
  document.getElementById('mute-key-row').style.pointerEvents = S.settings.muteKeybind ? '' : 'none';
}

export function startListeningMuteKey() {
  S.setMuteKeyListening(true);
  const btn = document.getElementById('mute-key-btn');
  btn.textContent = 'Press a key…';
  btn.classList.add('listening');
}

export function onBcPauseKeybindToggle() {
  S.settings.bcPauseKeybind = document.getElementById('toggle-bcpause-keybind').checked;
  document.getElementById('bcpause-key-row').style.opacity       = S.settings.bcPauseKeybind ? '1' : '0.4';
  document.getElementById('bcpause-key-row').style.pointerEvents = S.settings.bcPauseKeybind ? '' : 'none';
}

export function startListeningBcPauseKey() {
  S.setBcPauseKeyListening(true);
  const btn = document.getElementById('bcpause-key-btn');
  btn.textContent = 'Press a key…';
  btn.classList.add('listening');
}

export function setPTTTransmit(active) {
  if (!S.localStream) return;
  S.localStream.getAudioTracks().forEach(t => t.enabled = active);
  document.getElementById('ptt-indicator').classList.toggle('visible', active);
  playSound(active ? 'ptt-on' : 'ptt-off');
}

export function updatePTTButton() {
  const btn      = document.getElementById('btn-mute');
  const touchBtn = document.getElementById('ptt-touch-btn');
  const anyPTT   = S.settings.pushToTalk || S.settings.pttTouch;

  if (anyPTT) {
    btn.classList.add('active-accent');
    btn.classList.remove('active-red');
    document.getElementById('icon-mute').textContent  = '🖐️';
    document.getElementById('label-mute').textContent = 'PTT';
  } else {
    btn.classList.remove('active-accent');
    applyAudioState();
  }

  // Show circular touch button only when touch PTT is enabled
  if (S.settings.pttTouch) {
    touchBtn.innerHTML = '🎙️';
    touchBtn.style.display = 'flex';
  } else {
    touchBtn.style.display = 'none';
  }
}

export function initPTTTouchButton() {
  const btn = document.getElementById('ptt-touch-btn');

  btn.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!S.settings.pttTouch || S.pttActive) return;
    S.setPttActive(true);
    btn.classList.add('active');
    setPTTTransmit(true);
  }, { passive: false });

  btn.addEventListener('touchend', e => {
    e.preventDefault();
    if (!S.pttActive) return;
    S.setPttActive(false);
    btn.classList.remove('active');
    setPTTTransmit(false);
  }, { passive: false });

  btn.addEventListener('touchcancel', e => {
    if (!S.pttActive) return;
    S.setPttActive(false);
    btn.classList.remove('active');
    setPTTTransmit(false);
  }, { passive: false });
}

// ── Mute / Deafen ──
export function toggleMute() {
  if (S.settings.pushToTalk || S.settings.pttTouch) return; // PTT controls mic
  if (S.isDeafened) return;
  S.setIsMuted(!S.isMuted);
  playSound(S.isMuted ? 'mute' : 'unmute');
  socket.emit('set-self-muted', { muted: S.isMuted });
  applyAudioState();
}

export function toggleDeafen() {
  S.setIsDeafened(!S.isDeafened);
  S.setIsMuted(S.isDeafened);
  playSound(S.isDeafened ? 'deafen' : 'undeafen');
  socket.emit('set-self-deafened', { deafened: S.isDeafened });
  socket.emit('set-self-muted', { muted: S.isMuted });
  applyAudioState();
}

export function applyAudioState() {
  const anyPTT = S.settings.pushToTalk || S.settings.pttTouch;
  if (S.localStream) S.localStream.getAudioTracks().forEach(t => t.enabled = !S.isMuted && !anyPTT);
  document.getElementById('icon-mute').innerHTML    = S.isMuted    ? S.SVG_MIC_OFF : S.SVG_MIC_ON;
  document.getElementById('label-mute').textContent = S.isMuted    ? (S.isDeafened ? 'Muted' : 'Unmute') : 'Mute';
  document.getElementById('btn-mute').classList.toggle('active-red', S.isMuted && !anyPTT);
  document.getElementById('icon-deaf').innerHTML    = S.isDeafened ? S.SVG_DEAF_OFF : S.SVG_DEAF_ON;
  document.getElementById('label-deaf').textContent = S.isDeafened ? 'Undeafen' : 'Deafen';
  document.getElementById('btn-deaf').classList.toggle('active-red', S.isDeafened);
  const myCard = document.getElementById(`card-${socket.id}`);
  if (myCard) rebuildTags(myCard, true);
}

export function updateMyCard() {
  const card = document.getElementById(`card-${socket.id}`);
  if (!card) return;
  card.classList.toggle('speaking', S.amISpeaking && !S.isMuted && !S.settings.pushToTalk);
  rebuildTags(card, true);
}

export function rebuildTags(card, isMe) {
  const tagsEl = card.querySelector('.member-tags');
  if (!tagsEl) return;
  const sid      = card.id.replace('card-', '');
  const isBc     = card.classList.contains('broadcaster-card');
  const locMuted = !isMe && S.localMuted[sid];
  const member   = (S.partyData[S.currentParty]||[]).find(m=>m.socketId===sid);
  const srvMuted = !isMe && member?.serverMuted;
  const isAdminCard = !isMe && member?.isAdmin;
  const peerMuted = !isMe && member?.selfMuted;
  const peerDeafened = !isMe && member?.selfDeafened;
  tagsEl.innerHTML =
    (isBc          ? '<span class="tag tag-broadcaster">Broadcaster</span>' : '') +
    (isAdminCard   ? '<span class="tag tag-admin">Admin</span>'             : '') +
    (isMe && S.isAdmin ? '<span class="tag tag-admin">Admin</span>'           : '') +
    (isMe && S.amISpeaking && !S.isMuted && !S.settings.pushToTalk ? '<span class="tag tag-speaking">Speaking</span>' : '') +
    (isMe && S.settings.pushToTalk ? '<span class="tag tag-ptt">PTT</span>'  : '') +
    (isMe && S.isMuted && !S.isDeafened && !S.settings.pushToTalk ? '<span class="tag tag-muted">Muted</span>' : '') +
    (isMe && S.isDeafened ? '<span class="tag tag-deafened">Deafened</span>' : '') +
    (isMe && S.serverMutedMe ? '<span class="tag tag-server-muted">Server Muted</span>' : '') +
    (peerDeafened ? '<span class="tag tag-deafened">Deafened</span>' : '') +
    (peerMuted && !peerDeafened ? '<span class="tag tag-muted">Muted</span>' : '') +
    (srvMuted ? '<span class="tag tag-server-muted">Server Muted</span>'   : '') +
    (locMuted ? '<span class="tag tag-local-muted">Muted by you</span>'    : '');
}

// ── Admin ──
export function onAdminClick() {
  openAdminModal();
}

export function openAdminModal() {
  document.getElementById('admin-modal').classList.remove('hidden');
  document.getElementById('admin-pass-input').value = '';
  document.getElementById('admin-err').textContent  = '';
  setTimeout(() => document.getElementById('admin-pass-input').focus(), 100);
}

export function closeAdminModal() {
  document.getElementById('admin-modal').classList.add('hidden');
}

export function submitAdminPassword() {
  const pw = document.getElementById('admin-pass-input').value;
  socket.emit('claim-admin', { password: pw }, (res) => {
    if (!res.ok) {
      document.getElementById('admin-err').textContent = res.error || 'Wrong password';
      return;
    }
    closeAdminModal();
    // Owner code was correct — open admin management panel
    S.setOwnerCode(pw);
    openAdminManagement();
  });
}

export function adminServerMute() {
  if (!S.isAdmin || !S.popoverTarget) return;
  const member = Object.values(S.partyData).flat().find(m => m.socketId === S.popoverTarget);
  const currentlyMuted = member?.serverMuted || false;
  socket.emit('admin-mute', { targetId: S.popoverTarget, muted: !currentlyMuted });
  closePopover();
}

export function adminKick() {
  if (!S.isAdmin || !S.popoverTarget) return;
  const member = Object.values(S.partyData).flat().find(m => m.socketId === S.popoverTarget);
  if (!confirm(`Disconnect ${member?.username}?`)) return;
  socket.emit('admin-disconnect', { targetId: S.popoverTarget });
  closePopover();
}

// ── Admin Management (owner only) ──
export function openAdminManagement() {
  document.getElementById('admin-mgmt-modal').classList.remove('hidden');
  document.getElementById('mgmt-search').value = '';
  document.getElementById('mgmt-err').textContent = '';
  doMgmtSearch('');
  setTimeout(() => document.getElementById('mgmt-search').focus(), 100);
}

export function closeAdminManagement() {
  document.getElementById('admin-mgmt-modal').classList.add('hidden');
}

export function onMgmtSearch() {
  clearTimeout(S.mgmtSearchTimeout);
  S.setMgmtSearchTimeout(setTimeout(() => {
    doMgmtSearch(document.getElementById('mgmt-search').value.trim());
  }, 250));
}

export function doMgmtSearch(query) {
  const listEl = document.getElementById('mgmt-user-list');
  listEl.innerHTML = '<div class="mgmt-empty">Searching…</div>';
  socket.emit('owner-search-users', { query, ownerCode: S.ownerCode }, (res) => {
    if (!res.ok) {
      listEl.innerHTML = '<div class="mgmt-empty">Error: ' + esc(res.error || 'Unknown error') + '</div>';
      return;
    }
    if (!res.users.length) {
      listEl.innerHTML = '<div class="mgmt-empty">No users found</div>';
      return;
    }
    listEl.innerHTML = res.users.map(u => {
      const roleCls = 'role-' + (u.role || 'user');
      const isOwnerRole = u.role === 'owner';
      const isAdminRole = u.role === 'admin';
      let actionBtn = '';
      if (isOwnerRole) {
        actionBtn = '<span style="font-size:11px;color:var(--text-3);white-space:nowrap">Owner</span>';
      } else if (isAdminRole) {
        actionBtn = '<button class="mgmt-btn mgmt-btn-revoke" data-mgmt-action="revoke" data-mgmt-user="' + esc(u.username) + '">Revoke Admin</button>';
      } else {
        actionBtn = '<button class="mgmt-btn mgmt-btn-grant" data-mgmt-action="grant" data-mgmt-user="' + esc(u.username) + '">Grant Admin</button>';
      }
      return '<div class="mgmt-user-row">' +
        '<div class="mgmt-user-avatar">' + esc(u.username[0].toUpperCase()) + '</div>' +
        '<div class="mgmt-user-info"><div class="mgmt-user-name">' + esc(u.username) + '</div></div>' +
        '<span class="mgmt-role-badge ' + roleCls + '">' + esc(u.role || 'user') + '</span>' +
        actionBtn +
      '</div>';
    }).join('');
    // Use event delegation for grant/revoke buttons
    listEl.querySelectorAll('[data-mgmt-action]').forEach(btn => {
      btn.addEventListener('click', function() {
        const action = this.getAttribute('data-mgmt-action');
        const username = this.getAttribute('data-mgmt-user');
        if (action === 'grant') mgmtGrantAdmin(username);
        else if (action === 'revoke') mgmtRevokeAdmin(username);
      });
    });
  });
}

export function mgmtGrantAdmin(username) {
  document.getElementById('mgmt-err').textContent = '';
  socket.emit('owner-grant-admin', { targetUsername: username, ownerCode: S.ownerCode }, (res) => {
    if (!res.ok) {
      document.getElementById('mgmt-err').textContent = res.error || 'Failed';
      return;
    }
    notify('Granted admin to ' + username, 'success');
    doMgmtSearch(document.getElementById('mgmt-search').value.trim());
  });
}

export function mgmtRevokeAdmin(username) {
  document.getElementById('mgmt-err').textContent = '';
  socket.emit('owner-revoke-admin', { targetUsername: username, ownerCode: S.ownerCode }, (res) => {
    if (!res.ok) {
      document.getElementById('mgmt-err').textContent = res.error || 'Failed';
      return;
    }
    notify('Revoked admin from ' + username, 'success');
    doMgmtSearch(document.getElementById('mgmt-search').value.trim());
  });
}

// ── Broadcast ──
export function toggleBroadcaster() {
  S.isBroadcaster ? stopBroadcast() : openBroadcastModal();
}

export function openBroadcastModal() {
  const grid   = document.getElementById('bc-party-grid');
  const allBtn = document.getElementById('bc-all-btn');
  grid.innerHTML = '';
  grid.appendChild(allBtn);

  for (let i = 1; i <= 12; i++) {
    const count = (S.partyData[i] || []).length;
    const btn = document.createElement('button');
    btn.className = 'bc-party-btn' + (S.bcPartySelected.has(i) && !S.bcAllSelected ? ' selected' : '');
    btn.id = `bc-party-${i}`;
    btn.innerHTML = `Party ${i}<span class="bc-party-count">${count} member${count !== 1 ? 's' : ''}</span>`;
    btn.onclick = () => bcToggleParty(i);
    grid.appendChild(btn);
  }
  if (!S.isBroadcaster) {
    S.setBcAllSelected(true);
    S.bcPartySelected.clear();
    document.getElementById('bc-all-btn').classList.add('selected');
  }
  updateBcSelectedLabel();
  document.getElementById('broadcast-modal').classList.remove('hidden');
}

export function closeBroadcastModal() {
  document.getElementById('broadcast-modal').classList.add('hidden');
}

export function bcToggleAll() {
  S.setBcAllSelected(true);
  S.bcPartySelected.clear();
  document.getElementById('bc-all-btn').classList.add('selected');
  document.querySelectorAll('.bc-party-btn').forEach(b => b.classList.remove('selected'));
  updateBcSelectedLabel();
}

export function bcToggleParty(id) {
  S.setBcAllSelected(false);
  document.getElementById('bc-all-btn').classList.remove('selected');
  if (S.bcPartySelected.has(id)) {
    S.bcPartySelected.delete(id);
  } else {
    S.bcPartySelected.add(id);
  }
  const btn = document.getElementById(`bc-party-${id}`);
  if (btn) btn.classList.toggle('selected', S.bcPartySelected.has(id));
  if (S.bcPartySelected.size === 0) bcToggleAll();
  updateBcSelectedLabel();
}

export function updateBcSelectedLabel() {
  const label = document.getElementById('bc-selected-label');
  if (!label) return;
  if (S.bcAllSelected) {
    label.textContent = 'Broadcasting to all parties';
  } else {
    const sorted = [...S.bcPartySelected].sort((a,b) => a-b);
    label.textContent = `Broadcasting to: Party ${sorted.join(', Party ')}`;
  }
}

export function startBroadcast() {
  S.setBcTargets(S.bcAllSelected ? 'all' : [...S.bcPartySelected]);
  S.setBcPaused(false);
  S.setIsBroadcaster(true);

  closeBroadcastModal();
  document.getElementById('broadcaster-toggle').classList.remove('active-paused');
  document.getElementById('broadcaster-toggle').classList.add('active-red');
  socket.emit('set-broadcaster', { isBroadcaster: true, targets: S.bcTargets, paused: false });

  const label = S.bcTargets === 'all' ? 'all parties' : `Party ${[...S.bcPartySelected].sort((a,b)=>a-b).join(', ')}`;
  notify(`🔴 Broadcasting to ${label}`, 'success');
  updateBcPauseBtn();
}

export function stopBroadcast() {
  S.setIsBroadcaster(false);
  S.setBcPaused(false);
  document.getElementById('broadcaster-toggle').classList.remove('active-red', 'active-paused');
  socket.emit('set-broadcaster', { isBroadcaster: false });
  notify('Broadcasting stopped');
  updateBcPauseBtn();
}

export function onBroadcastPauseToggle() {
  if (!S.isBroadcaster) return;
  S.setBcPaused(!S.bcPaused);
  socket.emit('set-broadcast-paused', { paused: S.bcPaused });
  const pill = document.getElementById('broadcaster-toggle');
  if (S.bcPaused) {
    pill.classList.remove('active-red'); pill.classList.add('active-paused');
    notify('⏸ Broadcast paused', 'warn');
  } else {
    pill.classList.remove('active-paused'); pill.classList.add('active-red');
    notify('▶ Broadcast resumed', 'success');
  }
  updateBcPauseBtn();
}

export function updateBcPauseBtn() {
  const btn   = document.getElementById('btn-bc-pause');
  const icon  = document.getElementById('icon-bc-pause');
  const label = document.getElementById('label-bc-pause');
  if (!btn) return;
  if (S.isBroadcaster) {
    btn.style.display = 'flex';
    if (S.bcPaused) {
      btn.classList.add('bc-paused');
      if (icon)  icon.innerHTML  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      if (label) label.textContent = 'Resume BC';
    } else {
      btn.classList.remove('bc-paused');
      if (icon)  icon.innerHTML  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
      if (label) label.textContent = 'Pause BC';
    }
  } else {
    btn.style.display = 'none';
  }
}

// ── Popover ──
export function openPopover(sid, event) {
  event.stopPropagation();
  const member = Object.values(S.partyData).flat().find(m => m.socketId === sid);
  if (!member) return;
  S.setPopoverTarget(sid);

  const popAvatar = document.getElementById('pop-avatar');
  if (member.avatarUrl) {
    popAvatar.innerHTML = `<img src="${esc(member.avatarUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
  } else {
    popAvatar.innerHTML = '';
    popAvatar.textContent = member.username[0].toUpperCase();
  }
  document.getElementById('pop-name').textContent   = member.username;

  const pop  = document.getElementById('popover');

  // Apply the user's banner color as popover top accent
  pop.style.borderTop = `3px solid ${safeColor(member.bannerColor)}`;

  const vol = S.localVolume[sid] ?? 100;
  document.getElementById('pop-vol-slider').value      = vol;
  document.getElementById('pop-vol-value').textContent = vol + '%';

  const muted = S.localMuted[sid] || false;
  document.getElementById('pop-mute-icon').textContent  = muted ? '🔊' : '🔇';
  document.getElementById('pop-mute-label').textContent = muted ? 'Unmute for me' : 'Mute for me';
  document.getElementById('pop-mute-btn').classList.toggle('is-active', muted);

  // Admin controls visibility
  const showAdmin = S.isAdmin;
  document.getElementById('pop-admin-divider').style.display  = showAdmin ? '' : 'none';
  document.getElementById('pop-servermute-btn').style.display = showAdmin ? '' : 'none';
  document.getElementById('pop-kick-btn').style.display       = showAdmin ? '' : 'none';

  if (showAdmin) {
    const srvMuted = member.serverMuted || false;
    document.getElementById('pop-sm-icon').textContent  = srvMuted ? '🔊' : '🔕';
    document.getElementById('pop-sm-label').textContent = srvMuted ? 'Unmute (server)' : 'Server mute';
    document.getElementById('pop-servermute-btn').classList.toggle('is-active', srvMuted);
  }

  const card = document.getElementById(`card-${sid}`);
  const rect = card.getBoundingClientRect();
  pop.style.display = 'block';
  document.getElementById('popover-overlay').classList.add('open');

  const pw = 230, ph = showAdmin ? 240 : 160;
  let top  = rect.bottom + 8;
  let left = rect.left;
  if (top  + ph > window.innerHeight - 20) top  = rect.top - ph - 8;
  if (left + pw > window.innerWidth  - 16) left = window.innerWidth - pw - 16;
  if (top < 70) top = 70; if (left < 8) left = 8;
  pop.style.top = top + 'px'; pop.style.left = left + 'px';
}

export function closePopover() {
  document.getElementById('popover').style.display = 'none';
  document.getElementById('popover-overlay').classList.remove('open');
  S.setPopoverTarget(null);
}

export function onVolSlider(val) {
  if (!S.popoverTarget) return;
  const v = parseInt(val);
  S.localVolume[S.popoverTarget] = v;
  document.getElementById('pop-vol-value').textContent = v + '%';
  if (S.peerPlayers[S.popoverTarget]) S.peerPlayers[S.popoverTarget].gainNode.gain.value = v / 100;
  const card = document.getElementById(`card-${S.popoverTarget}`);
  if (card) {
    const av = card.querySelector('.member-avatar');
    if (v !== 100) { av.setAttribute('data-vol', v+'%'); av.classList.add('vol-custom'); }
    else           { av.removeAttribute('data-vol'); av.classList.remove('vol-custom'); }
  }
}

export function toggleLocalMute() {
  if (!S.popoverTarget) return;
  S.localMuted[S.popoverTarget] = !S.localMuted[S.popoverTarget];
  const muted = S.localMuted[S.popoverTarget];
  document.getElementById('pop-mute-icon').textContent  = muted ? '🔊' : '🔇';
  document.getElementById('pop-mute-label').textContent = muted ? 'Unmute for me' : 'Mute for me';
  document.getElementById('pop-mute-btn').classList.toggle('is-active', muted);
  const card = document.getElementById(`card-${S.popoverTarget}`);
  if (card) {
    card.classList.toggle('user-muted-local', muted);
    rebuildTags(card, false);
    if (muted) {
      import('./audio-engine.js').then(({ showPeerSpeaking }) => {
        showPeerSpeaking(S.popoverTarget, false);
      });
    }
  }
}

// ── Sidebar ──
export function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
export function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ── Member Sidebar (mobile) ──
export function toggleMemberSidebar() {
  document.getElementById('member-sidebar').classList.toggle('sidebar-open');
  document.getElementById('member-sidebar-overlay').classList.toggle('open');
}
export function closeMemberSidebar() {
  document.getElementById('member-sidebar').classList.remove('sidebar-open');
  document.getElementById('member-sidebar-overlay').classList.remove('open');
}

export function renderSidebar() {
  const list = document.getElementById('party-list');
  list.innerHTML = '';
  for (let i = 1; i <= 12; i++) {
    const members = S.partyData[i] || [];
    const count   = members.length;
    const active  = S.currentParty === i;

    // Channel row
    const div = document.createElement('div');
    div.className = 'channel-item' + (active ? ' active' : '') + (count > 0 ? ' has-members' : '');
    div.onclick = () => { joinParty(i); closeSidebar(); };
    div.innerHTML = `<span class="ch-icon">${active?'🔊':'🔈'}</span><span class="ch-label">Party ${i}</span><span class="ch-count">${count||''}</span>`;
    
    // Make channel a drop target for admins
    if (S.isAdmin) {
      div.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        div.classList.add('drag-over');
      };
      div.ondragleave = (e) => {
        div.classList.remove('drag-over');
      };
      div.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        div.classList.remove('drag-over');
        const targetId = e.dataTransfer.getData('text/plain');
        if (targetId && targetId !== socket.id) {
          socket.emit('admin-move', { targetId, toPartyId: i });
        }
      };
    }
    
    list.appendChild(div);

    // Member list under channel (always shown if has members)
    if (count > 0) {
      const memberList = document.createElement('div');
      memberList.className = 'ch-members';
      memberList.style.display = 'block';
      members.forEach(m => {
        const isMe = m.socketId === socket.id;
        const row  = document.createElement('div');
        row.className = 'ch-member-row';
        row.dataset.sid = m.socketId;
        
        // Make draggable for admins (except for yourself)
        if (S.isAdmin && !isMe) {
          row.draggable = true;
          row.ondragstart = (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', m.socketId);
            row.classList.add('dragging');
          };
          row.ondragend = (e) => {
            row.classList.remove('dragging');
          };
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'ch-member-name' + (isMe ? ' is-you' : '') + (m.serverMuted ? ' is-muted' : '') + (m.selfMuted ? ' self-muted' : '') + (m.selfDeafened ? ' self-deafened' : '');
        const muteIcon = m.selfDeafened ? '🔕' : m.selfMuted ? '🔇' : '';
        const streamIcon = m.isStreaming ? '🖥️ ' : '';
        nameSpan.textContent = (isMe ? '▶ ' : '') + streamIcon + muteIcon + (muteIcon ? ' ' : '') + m.username;
        row.appendChild(nameSpan);

        // Latency indicator
        const lat = isMe ? S.myLatency : S.peerLatency[m.socketId];
        if (lat != null) {
          const latSpan = document.createElement('span');
          latSpan.className = 'ch-latency ' + latencyClass(lat);
          latSpan.textContent = lat + 'ms';
          row.appendChild(latSpan);
        }

        // Tags (hidden on hover in favour of admin buttons)
        const tags = document.createElement('div');
        tags.className = 'ch-member-tags';
        if (m.isAdmin)      tags.innerHTML += '<span class="ch-tag ch-tag-admin">ADM</span>';
        if (m.serverMuted)  tags.innerHTML += '<span class="ch-tag ch-tag-muted">MUTED</span>';
        if (m.selfDeafened) tags.innerHTML += '<span class="ch-tag ch-tag-deafened">DEAF</span>';
        else if (m.selfMuted) tags.innerHTML += '<span class="ch-tag ch-tag-muted">MUTE</span>';
        row.appendChild(tags);

        // Admin buttons (shown on hover, only if isAdmin)
        if (S.isAdmin && !isMe) {
          const adminBtns = document.createElement('div');
          adminBtns.className = 'ch-admin-btns';
          const muteLabel = m.serverMuted ? 'Unmute' : 'Mute';
          const muteBtnEl = document.createElement('button');
          muteBtnEl.className = 'ch-admin-btn mute-btn';
          muteBtnEl.textContent = muteLabel;
          muteBtnEl.onclick = (event) => sidebarAdminMute(m.socketId, m.serverMuted, event);
          const kickBtnEl = document.createElement('button');
          kickBtnEl.className = 'ch-admin-btn';
          kickBtnEl.textContent = 'Kick';
          kickBtnEl.onclick = (event) => sidebarAdminKick(m.socketId, m.username, event);
          adminBtns.appendChild(muteBtnEl);
          adminBtns.appendChild(kickBtnEl);
          row.appendChild(adminBtns);
        }

        memberList.appendChild(row);
      });
      list.appendChild(memberList);
    }
  }
  if (S.currentParty) {
    const lb = document.createElement('button');
    lb.className = 'leave-btn'; lb.innerHTML = '✕ &nbsp;Leave channel';
    lb.onclick = () => { leaveParty(); closeSidebar(); };
    list.appendChild(lb);
  }
}

export function sidebarAdminMute(targetId, currentlyMuted, event) {
  event.stopPropagation();
  if (!S.isAdmin) return;
  socket.emit('admin-mute', { targetId, muted: !currentlyMuted });
}

export function sidebarAdminKick(targetId, username, event) {
  event.stopPropagation();
  if (!S.isAdmin) return;
  if (!confirm('Disconnect ' + username + '?')) return;
  socket.emit('admin-disconnect', { targetId });
}

export function renderMainPanel() {
  const empty    = document.getElementById('empty-state');
  const view     = document.getElementById('party-view');
  const leaveBtn = document.getElementById('btn-leave');
  const chanName = document.getElementById('header-channel-name');
  if (leaveBtn) leaveBtn.style.display = S.currentParty ? 'flex' : 'none';
  if (chanName) chanName.textContent = S.currentParty ? `Party ${S.currentParty}` : 'No Channel';
  updateBcPauseBtn();
  updateScreenShareBtn();
  if (!S.currentParty) { empty.style.display='flex'; view.style.display='none'; return; }
  empty.style.display='none'; view.style.display='block';

  const members = S.partyData[S.currentParty] || [];
  const broadcasters = [];
  for (let i = 1; i <= 12; i++) {
    (S.partyData[i]||[]).forEach(m => {
      if (m.isBroadcaster && m.socketId !== socket.id && !broadcasters.find(b=>b.socketId===m.socketId))
        broadcasters.push(m);
    });
  }

  const streamingCount = members.filter(m => m.isStreaming).length;
  const streamingText = streamingCount > 0 ? ` · ${streamingCount} streaming` : '';
  let html = `<div class="party-header">
    <div class="party-header-icon">🎙️</div>
    <div>
      <div class="party-title">Party ${S.currentParty}</div>
      <div class="party-sub">${members.length} member${members.length!==1?'s':''}${streamingText} · Click a user to adjust volume${S.isAdmin?' · Admin mode active':''}</div>
    </div>
  </div>`;

  if (broadcasters.length > 0) {
    const bcInfo = broadcasters.map(b => {
      const targets = b.broadcastTargets;
      const targetText = targets === 'all' ? 'all parties' : `Party ${Array.isArray(targets) ? targets.sort((a,b)=>a-b).join(', ') : targets}`;
      return `${esc(b.username)} → ${targetText}`;
    }).join(' | ');
    html += `<div class="broadcast-banner"><div class="bc-banner-dot" style="${broadcasters.some(b=>b.broadcastPaused)?'animation:none;opacity:0.4':''}"></div><div class="bc-banner-text">${broadcasters.some(b=>b.broadcastPaused)?'⏸ PAUSED —':'LIVE BROADCAST —'} ${bcInfo}</div></div>`;
  }

  const allCards = [...members];
  broadcasters.forEach(b => { if (!allCards.find(m=>m.socketId===b.socketId)) allCards.push(b); });

  html += `<div class="members-grid">`;
  if (members.find(m=>m.socketId===socket.id) || S.isBroadcaster)
    html += memberCardHTML({ socketId: socket.id, username: S.myUsername, isBroadcaster: S.isBroadcaster, isAdmin: S.isAdmin, serverMuted: S.serverMutedMe, isStreaming: S.isStreaming }, true);
  allCards.forEach(m => { if (m.socketId !== socket.id) html += memberCardHTML(m, false); });
  html += `</div>`;
  view.innerHTML = html;
}

function getMemberRole(username) {
  const entry = S.memberList.find(u => u.username === username);
  return entry?.role || 'user';
}

function memberCardHTML(m, isMe) {
  const speaking   = isMe ? (S.amISpeaking && !S.isMuted && !S.settings.pushToTalk) : false;
  const muted      = isMe && S.isMuted && !S.isDeafened && !S.settings.pushToTalk;
  const deafened   = isMe && S.isDeafened;
  const peerMuted  = !isMe && m.selfMuted && !m.selfDeafened;
  const peerDeafened = !isMe && m.selfDeafened;
  const locMuted   = !isMe && S.localMuted[m.socketId];
  const vol        = S.localVolume[m.socketId] ?? 100;
  const volCustom  = !isMe && vol !== 100;
  const srvMuted   = m.serverMuted || false;
  const lat        = isMe ? S.myLatency : S.peerLatency[m.socketId];
  const latCls     = latencyClass(lat);
  const avatarUrl  = isMe ? S.myAvatarUrl : (m.avatarUrl || '');
  const avatarContent = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
    : esc((m.username || '?')[0].toUpperCase());
  const bannerColor = safeColor(isMe ? S.myBannerColor : (m.bannerColor || '#5865f2'));
  const memberRole = isMe ? S.myRole : getMemberRole(m.username);
  const glowClass = memberRole === 'owner' ? ' role-owner-glow' : memberRole === 'admin' ? ' role-admin-glow' : '';

  const isStreamingMember = !isMe && m.isStreaming;
  const streamingClass = isStreamingMember ? ' streaming-card' : '';
  const cardClick = !isMe
    ? (isStreamingMember
      ? `onclick="window._watchStream('${m.socketId}')"`
      : `onclick="window._openPopover('${m.socketId}',event)"`)
    : '';

  return `<div class="member-card${speaking?' speaking':''}${m.isBroadcaster?' broadcaster-card':''}${locMuted?' user-muted-local':''}${srvMuted&&!isMe?' server-muted-card':''}${streamingClass}"
    id="card-${m.socketId}"
    style="border-top:3px solid ${bannerColor}"
    ${cardClick}>
    <div class="member-avatar${volCustom?' vol-custom':''}${glowClass}" ${volCustom?`data-vol="${vol}%"`:''}>${avatarContent}</div>
    <div class="member-name">${esc(m.username)}</div>
    ${isMe?'<div class="member-you">· you</div>':''}
    <div class="member-tags">
      ${m.isStreaming?'<span class="tag tag-streaming">🖥️ Live</span>':''}
      ${m.isBroadcaster?'<span class="tag tag-broadcaster">Broadcaster</span>':''}
      ${(isMe?S.isAdmin:m.isAdmin)?'<span class="tag tag-admin">Admin</span>':''}
      ${speaking?'<span class="tag tag-speaking">Speaking</span>':''}
      ${isMe&&S.settings.pushToTalk?'<span class="tag tag-ptt">PTT</span>':''}
      ${muted?'<span class="tag tag-muted">Muted</span>':''}
      ${deafened?'<span class="tag tag-deafened">Deafened</span>':''}
      ${peerDeafened?'<span class="tag tag-deafened">Deafened</span>':''}
      ${peerMuted?'<span class="tag tag-muted">Muted</span>':''}
      ${isMe&&S.serverMutedMe?'<span class="tag tag-server-muted">Server Muted</span>':''}
      ${!isMe&&srvMuted?'<span class="tag tag-server-muted">Server Muted</span>':''}
      ${locMuted?'<span class="tag tag-local-muted">Muted by you</span>':''}
    </div>
    ${lat!=null?`<div class="latency-badge ${latCls}">${lat} ms</div>`:''}
  </div>`;
}

// ── Screen Share Button ──
export function toggleScreenShare() {
  if (S.isStreaming) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
}

export function updateScreenShareBtn() {
  const btn = document.getElementById('btn-screenshare');
  if (!btn) return;
  btn.style.display = S.currentParty ? 'flex' : 'none';
  const icon = document.getElementById('icon-screenshare');
  const label = document.getElementById('label-screenshare');
  if (S.isStreaming) {
    btn.classList.add('active-red');
    if (icon) icon.innerHTML = '🖥️';
    if (label) label.textContent = 'Stop';
  } else {
    btn.classList.remove('active-red');
    if (icon) icon.innerHTML = '🖥️';
    if (label) label.textContent = 'Share';
  }
}

// ── Join / Leave ──
export function joinParty(partyId) {
  if (S.currentParty === partyId) return;
  Object.keys(S.peerPlayers).forEach(removePeerPlayer);
  S.setCurrentParty(partyId);
  socket.emit('join-party', { partyId });
  playSound('join');
  if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();
  startPingLoop();
}

export function leaveParty() {
  if (!S.currentParty) return;
  if (S.isStreaming) stopScreenShare();
  if (S.watchingStreamerId) stopWatchingStream();
  Object.keys(S.peerPlayers).forEach(removePeerPlayer);
  socket.emit('leave-party');
  playSound('leave');
  S.setCurrentParty(null);
  stopPingLoop();
  Object.keys(S.peerLatency).forEach(k => delete S.peerLatency[k]);
  renderSidebar(); renderMainPanel();
}

// ── Latency display ──
export function updateLatencyDisplay() {
  // Update own card latency badge
  const myCard = document.getElementById('card-' + socket.id);
  if (myCard) {
    let badge = myCard.querySelector('.latency-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'latency-badge';
      myCard.appendChild(badge);
    }
    badge.className = 'latency-badge ' + latencyClass(S.myLatency);
    badge.textContent = S.myLatency != null ? S.myLatency + ' ms' : '';
  }
  // Update peer card latency badges
  Object.entries(S.peerLatency).forEach(([sid, ms]) => {
    const card = document.getElementById('card-' + sid);
    if (card) {
      let badge = card.querySelector('.latency-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'latency-badge';
        card.appendChild(badge);
      }
      badge.className = 'latency-badge ' + latencyClass(ms);
      badge.textContent = ms + ' ms';
    }
  });
  // Update sidebar latency spans via data-sid attributes
  const allLat = { [socket.id]: S.myLatency, ...S.peerLatency };
  Object.entries(allLat).forEach(([sid, ms]) => {
    const row = document.querySelector(`.ch-member-row[data-sid="${sid}"]`);
    if (!row) return;
    let latSpan = row.querySelector('.ch-latency');
    if (ms != null) {
      if (!latSpan) {
        latSpan = document.createElement('span');
        latSpan.className = 'ch-latency';
        const tags = row.querySelector('.ch-member-tags');
        row.insertBefore(latSpan, tags);
      }
      latSpan.className = 'ch-latency ' + latencyClass(ms);
      latSpan.textContent = ms + 'ms';
    } else if (latSpan) {
      latSpan.remove();
    }
  });
}

// ── Role badge ──
export function updateRoleBadge() {
  const badgeAdmin = document.getElementById('badge-admin');
  const badgeOwner = document.getElementById('badge-owner');
  if (!badgeAdmin || !badgeOwner) return;
  if (S.myRole === 'owner') {
    badgeAdmin.classList.add('hidden');
    badgeOwner.classList.remove('hidden');
  } else if (S.myRole === 'admin') {
    badgeAdmin.classList.remove('hidden');
    badgeOwner.classList.add('hidden');
  } else {
    badgeAdmin.classList.add('hidden');
    badgeOwner.classList.add('hidden');
  }
  updateOwnerLoginVisibility();
}

// ── Logout ──
export function logout() {
  if (!confirm('Sign out of OathlyVoice?')) return;
  if (S.isStreaming) stopScreenShare();
  if (S.watchingStreamerId) stopWatchingStream();
  if (S.currentParty) socket.emit('leave-party');
  if (S.isBroadcaster) { S.setIsBroadcaster(false); socket.emit('set-broadcaster', { isBroadcaster: false }); }
  if (S.micVAD) { try { S.micVAD.destroy(); } catch(e){} S.setMicVAD(null); }
  if (S.processorNode?.port) { try { S.processorNode.port.postMessage('stop'); } catch(e){} }
  if (S.localStream) S.localStream.getTracks().forEach(t => t.stop());
  if (S.audioCtx)    { try { S.audioCtx.close(); }    catch(e){} S.setAudioCtx(null); }
  if (S.playbackCtx) { try { S.playbackCtx.close(); } catch(e){} S.setPlaybackCtx(null); }
  Object.keys(S.peerPlayers).forEach(removePeerPlayer);
  socket.disconnect();
  window.location.reload();
}

// ── Member Sidebar (right) ──
export function renderMemberSidebar() {
  const list = document.getElementById('member-sidebar-list');
  if (!list) return;

  const online  = S.memberList.filter(u => u.online).sort((a,b) => a.username.localeCompare(b.username));
  const offline = S.memberList.filter(u => !u.online).sort((a,b) => a.username.localeCompare(b.username));

  let html = '';
  if (online.length) {
    html += `<div class="msb-category">Online — ${online.length}</div>`;
    online.forEach(u => { html += msbUserHTML(u, true); });
  }
  if (offline.length) {
    html += `<div class="msb-category">Offline — ${offline.length}</div>`;
    offline.forEach(u => { html += msbUserHTML(u, false); });
  }
  list.innerHTML = html;

  list.querySelectorAll('[data-msb-user]').forEach(el => {
    el.addEventListener('click', () => openProfileModal(el.getAttribute('data-msb-user')));
  });
  filterMemberSidebar('');
  // Reset search input when list re-renders
  const searchInput = document.getElementById('msb-search');
  if (searchInput) searchInput.value = '';
}

function msbUserHTML(u, isOnline) {
  const avatarContent = u.avatarUrl
    ? `<img src="${esc(u.avatarUrl)}" alt="">`
    : esc((u.username || '?')[0].toUpperCase());
  const avatarStyle = u.avatarUrl ? `background-image:url('${esc(u.avatarUrl)}')` : '';
  const glowClass = u.role === 'owner' ? ' role-owner-glow' : u.role === 'admin' ? ' role-admin-glow' : '';
  return `<div class="msb-user${isOnline ? ' is-online' : ''}" data-msb-user="${esc(u.username)}">
    <div class="msb-user-avatar${glowClass}" ${avatarStyle ? `style="${avatarStyle}"` : ''}>
      ${u.avatarUrl ? '' : avatarContent}
      <span class="msb-status-dot ${isOnline ? 'online' : 'offline'}"></span>
    </div>
    <div class="msb-user-info">
      <div class="msb-user-name">${esc(u.username)}</div>
      ${u.customStatus ? `<div class="msb-user-status">${esc(u.customStatus)}</div>` : ''}
    </div>
  </div>`;
}

// ── Profile Modal (glassmorphism) ──
export function openProfileModal(username) {
  const user = S.memberList.find(u => u.username === username);
  if (!user) return;

  document.getElementById('profile-banner').style.background = user.bannerColor || '#5865f2';

  const avatarEl = document.getElementById('profile-avatar');
  if (user.avatarUrl) {
    avatarEl.innerHTML = `<img src="${esc(user.avatarUrl)}" alt="">`;
    avatarEl.style.backgroundImage = `url('${esc(user.avatarUrl)}')`;
  } else {
    avatarEl.innerHTML = esc((user.username || '?')[0].toUpperCase());
    avatarEl.style.backgroundImage = '';
  }

  const ring = document.getElementById('profile-status-ring');
  ring.className = 'profile-status-ring ' + (user.online ? 'online' : 'offline');

  document.getElementById('profile-username').textContent = user.username;
  document.getElementById('profile-custom-status').textContent = user.customStatus || '';

  const roleBadge = document.getElementById('profile-role-badge');
  roleBadge.className = 'profile-role-badge role-' + (user.role || 'user');
  roleBadge.textContent = (user.role === 'admin' || user.role === 'owner') ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '';

  document.getElementById('profile-bio').textContent = user.bio || 'No bio set.';
  document.getElementById('profile-modal').classList.remove('hidden');
}

export function closeProfileModal() {
  document.getElementById('profile-modal').classList.add('hidden');
}

// ── Profile Customization (settings tab) ──
export async function saveProfile() {
  if (S.isGuest || !S.myPassword) return notify('Sign in to save profile', 'error');
  const bio          = document.getElementById('profile-bio-input').value;
  const bannerColor  = document.getElementById('profile-banner-color').value;
  const customStatus = document.getElementById('profile-status-input').value;
  try {
    const res = await fetch('/voice/api/update-profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: S.myUsername, password: S.myPassword, bio, bannerColor, customStatus })
    });
    if (!res.ok) return notify('Could not save profile', 'error');
    const data = await res.json();
    if (!data.ok) return notify(data.error || 'Could not save profile', 'error');
    S.setMyBio(data.bio);
    S.setMyBannerColor(data.bannerColor);
    S.setMyCustomStatus(data.customStatus);
    socket.emit('update-profile', { avatarUrl: S.myAvatarUrl, bannerColor: data.bannerColor, bio: data.bio });
    notify('Profile saved ✓', 'success');
  } catch (e) {
    notify('Could not reach server', 'error');
  }
}

export async function onAvatarFileSelected() {
  if (S.isGuest || !S.myPassword) return notify('Sign in to upload avatar', 'error');
  const fileInput = document.getElementById('avatar-file-input');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('avatar', fileInput.files[0]);
  formData.append('username', S.myUsername);
  formData.append('password', S.myPassword);
  try {
    const res = await fetch('/voice/api/upload-avatar', { method: 'POST', body: formData });
    if (!res.ok) return notify('Upload failed', 'error');
    const data = await res.json();
    if (!data.ok) return notify(data.error || 'Upload failed', 'error');
    S.setMyAvatarUrl(data.avatarUrl);
    updateAvatarPreview();
    syncSidebarAvatar();
    socket.emit('update-profile', { avatarUrl: data.avatarUrl, bannerColor: S.myBannerColor, bio: S.myBio });
    notify('Avatar uploaded ✓', 'success');
  } catch (e) {
    notify('Could not reach server', 'error');
  }
}

function updateAvatarPreview() {
  const preview = document.getElementById('settings-avatar-preview');
  if (!preview) return;
  if (S.myAvatarUrl) {
    preview.innerHTML = `<img src="${esc(S.myAvatarUrl)}" alt="">`;
    preview.style.backgroundImage = `url('${esc(S.myAvatarUrl)}')`;
  } else {
    preview.innerHTML = esc((S.myUsername || '?')[0].toUpperCase());
    preview.style.backgroundImage = '';
  }
}

// initProfileSettingsUI removed — profile editing moved to Profile Editor modal

// ── Member Sidebar Search ──
export function filterMemberSidebar(query) {
  const q = query.trim().toLowerCase();
  const list = document.getElementById('member-sidebar-list');
  if (!list) return;
  list.querySelectorAll('.msb-user').forEach(el => {
    const name = el.getAttribute('data-msb-user') || '';
    el.style.display = (!q || name.toLowerCase().includes(q)) ? '' : 'none';
  });
  // Hide category headers if all their members are hidden
  list.querySelectorAll('.msb-category').forEach(cat => {
    let sibling = cat.nextElementSibling;
    let allHidden = true;
    while (sibling && !sibling.classList.contains('msb-category')) {
      if (sibling.style.display !== 'none') { allHidden = false; break; }
      sibling = sibling.nextElementSibling;
    }
    cat.style.display = allHidden ? 'none' : '';
  });
}

// ── Profile Editor Modal ──
export function openProfileEditor() {
  if (S.isGuest) {
    document.getElementById('pe-guest-notice').style.display = 'block';
    document.getElementById('pe-save-row').style.display = 'none';
  } else {
    document.getElementById('pe-guest-notice').style.display = 'none';
    document.getElementById('pe-save-row').style.display = 'block';
  }
  // Populate fields from current state
  document.getElementById('pe-status-input').value = S.myCustomStatus || '';
  document.getElementById('pe-bio-input').value    = S.myBio || '';
  document.getElementById('pe-banner-color').value = S.myBannerColor || '#5865f2';
  document.getElementById('pe-banner-color-label').textContent = S.myBannerColor || '#5865f2';
  updatePEPreview();
  document.getElementById('profile-editor-modal').classList.remove('hidden');
}

export function closeProfileEditor() {
  document.getElementById('profile-editor-modal').classList.add('hidden');
}

function updatePEPreview() {
  // Banner
  const banner = document.getElementById('pe-banner-preview');
  if (banner) banner.style.background = safeColor(S.myBannerColor || '#5865f2');
  // Avatar (preview in the card)
  const avatarEl = document.getElementById('pe-avatar-preview');
  if (avatarEl) {
    if (S.myAvatarUrl) {
      avatarEl.innerHTML = `<img src="${esc(S.myAvatarUrl)}" alt="">`;
    } else {
      avatarEl.innerHTML = esc((S.myUsername || '?')[0].toUpperCase());
    }
  }
  // Avatar thumb (small one next to upload button)
  const thumb = document.getElementById('pe-avatar-thumb');
  if (thumb) {
    if (S.myAvatarUrl) {
      thumb.innerHTML = `<img src="${esc(S.myAvatarUrl)}" alt="">`;
    } else {
      thumb.textContent = (S.myUsername || '?')[0].toUpperCase();
    }
  }
  // Name + status
  const nameEl = document.getElementById('pe-preview-name');
  if (nameEl) nameEl.textContent = S.myUsername || '';
  const statusEl = document.getElementById('pe-preview-status');
  if (statusEl) statusEl.textContent = S.myCustomStatus || '';
}

export function onPEBannerColorChange(val) {
  S.setMyBannerColor(val);
  document.getElementById('pe-banner-color-label').textContent = val;
  updatePEPreview();
}

export function onPEStatusInput(val) {
  S.setMyCustomStatus(val);
  updatePEPreview();
}

export async function onPEAvatarSelected() {
  if (S.isGuest || !S.myPassword) return notify('Sign in to upload avatar', 'error');
  const fileInput = document.getElementById('pe-avatar-input');
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append('avatar', fileInput.files[0]);
  formData.append('username', S.myUsername);
  formData.append('password', S.myPassword);
  try {
    const res = await fetch('/voice/api/upload-avatar', { method: 'POST', body: formData });
    if (!res.ok) return notify('Upload failed', 'error');
    const data = await res.json();
    if (!data.ok) return notify(data.error || 'Upload failed', 'error');
    S.setMyAvatarUrl(data.avatarUrl);
    syncSidebarAvatar();
    updatePEPreview();
    socket.emit('update-profile', { avatarUrl: data.avatarUrl, bannerColor: S.myBannerColor, bio: S.myBio });
    notify('Avatar uploaded ✓', 'success');
  } catch (e) {
    notify('Could not reach server', 'error');
  }
}

export async function savePEProfile() {
  if (S.isGuest || !S.myPassword) return notify('Sign in to save profile', 'error');
  const bio          = document.getElementById('pe-bio-input').value;
  const bannerColor  = document.getElementById('pe-banner-color').value;
  const customStatus = document.getElementById('pe-status-input').value;
  try {
    const res = await fetch('/voice/api/update-profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: S.myUsername, password: S.myPassword, bio, bannerColor, customStatus })
    });
    if (!res.ok) return notify('Could not save profile', 'error');
    const data = await res.json();
    if (!data.ok) return notify(data.error || 'Could not save profile', 'error');
    S.setMyBio(data.bio);
    S.setMyBannerColor(data.bannerColor);
    S.setMyCustomStatus(data.customStatus);
    socket.emit('update-profile', { avatarUrl: S.myAvatarUrl, bannerColor: data.bannerColor, bio: data.bio });
    updatePEPreview();
    notify('Profile saved ✓', 'success');
    closeProfileEditor();
  } catch (e) {
    notify('Could not reach server', 'error');
  }
}
