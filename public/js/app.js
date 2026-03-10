// ── App Entry Point ──
// Initializes the app and attaches event listeners
import * as S from './state.js';
import { socket } from './socket-client.js';
import {
  switchAuthTab, doLogin, doRegister, doGuest,
  openSettings, closeSettings, switchSettingsTab, onSensChange, onInputVolChange,
  onPttToggle, onNoiseCancelToggle, onPttTouchToggle,
  startListeningPTT, saveSettings,
  onMuteKeybindToggle, startListeningMuteKey,
  onBcPauseKeybindToggle, startListeningBcPauseKey,
  setPTTTransmit, toggleMute, toggleDeafen,
  onAdminClick, closeAdminModal, submitAdminPassword,
  closeAdminManagement, onMgmtSearch,
  toggleBroadcaster, closeBroadcastModal, bcToggleAll, startBroadcast,
  onBroadcastPauseToggle,
  openPopover, closePopover, onVolSlider, toggleLocalMute,
  adminServerMute, adminKick,
  toggleSidebar, closeSidebar, toggleMemberSidebar, closeMemberSidebar, leaveParty, logout,
  onInputDeviceChange, onOutputDeviceChange, populateDeviceList,
  openProfileModal, closeProfileModal,
  openProfileEditor, closeProfileEditor, onPEBannerColorChange, onPEStatusInput, onPEAvatarSelected, savePEProfile,
  filterMemberSidebar,
  toggleScreenShare
} from './ui-controller.js';
import { requestWatchStream } from './stream-engine.js';
import { playSound } from './utils.js';

// ── Expose functions to inline handlers in HTML ──
// These are called by onclick/onsubmit/onchange/oninput attributes in the HTML.
window.switchAuthTab        = switchAuthTab;
window.doLogin              = doLogin;
window.doRegister           = doRegister;
window.doGuest              = doGuest;
window.openSettings         = openSettings;
window.closeSettings        = closeSettings;
window.switchSettingsTab    = switchSettingsTab;
window.onSensChange         = onSensChange;
window.onInputVolChange     = onInputVolChange;
window.onPttToggle          = onPttToggle;
window.onNoiseCancelToggle  = onNoiseCancelToggle;
window.onPttTouchToggle     = onPttTouchToggle;
window.startListeningPTT    = startListeningPTT;
window.saveSettings         = saveSettings;
window.onMuteKeybindToggle  = onMuteKeybindToggle;
window.startListeningMuteKey    = startListeningMuteKey;
window.onBcPauseKeybindToggle   = onBcPauseKeybindToggle;
window.startListeningBcPauseKey = startListeningBcPauseKey;
window.toggleMute           = toggleMute;
window.toggleDeafen         = toggleDeafen;
window.onAdminClick         = onAdminClick;
window.closeAdminModal      = closeAdminModal;
window.submitAdminPassword  = submitAdminPassword;
window.closeAdminManagement = closeAdminManagement;
window.onMgmtSearch         = onMgmtSearch;
window.toggleBroadcaster    = toggleBroadcaster;
window.closeBroadcastModal  = closeBroadcastModal;
window.bcToggleAll          = bcToggleAll;
window.startBroadcast       = startBroadcast;
window.onBroadcastPauseToggle   = onBroadcastPauseToggle;
window._openPopover         = openPopover;
window.closePopover         = closePopover;
window.onVolSlider          = onVolSlider;
window.toggleLocalMute      = toggleLocalMute;
window.adminServerMute      = adminServerMute;
window.adminKick            = adminKick;
window.toggleSidebar        = toggleSidebar;
window.closeSidebar         = closeSidebar;
window.toggleMemberSidebar  = toggleMemberSidebar;
window.closeMemberSidebar   = closeMemberSidebar;
window.leaveParty           = leaveParty;
window.logout               = logout;
window.onInputDeviceChange  = onInputDeviceChange;
window.onOutputDeviceChange = onOutputDeviceChange;
window.openProfileModal     = openProfileModal;
window.closeProfileModal    = closeProfileModal;
window.openProfileEditor      = openProfileEditor;
window.closeProfileEditor     = closeProfileEditor;
window.onPEBannerColorChange  = onPEBannerColorChange;
window.onPEStatusInput        = onPEStatusInput;
window.onPEAvatarSelected     = onPEAvatarSelected;
window.savePEProfile          = savePEProfile;
window.filterMemberSidebar    = filterMemberSidebar;
window.toggleScreenShare      = toggleScreenShare;
window._watchStream           = requestWatchStream;

// ── Keyboard event handlers ──
document.addEventListener('keydown', e => {
  // Capture PTT key assignment
  if (S.pttListening) {
    e.preventDefault();
    S.settings.pttKey = e.code;
    document.getElementById('ptt-key-btn').textContent = e.code;
    document.getElementById('ptt-key-btn').classList.remove('listening');
    S.setPttListening(false);
    return;
  }
  // Capture mute key assignment
  if (S.muteKeyListening) {
    e.preventDefault();
    S.settings.muteKey = e.code;
    document.getElementById('mute-key-btn').textContent = e.code;
    document.getElementById('mute-key-btn').classList.remove('listening');
    S.setMuteKeyListening(false);
    return;
  }
  // Capture broadcast pause key assignment
  if (S.bcPauseKeyListening) {
    e.preventDefault();
    S.settings.bcPauseKey = e.code;
    document.getElementById('bcpause-key-btn').textContent = e.code;
    document.getElementById('bcpause-key-btn').classList.remove('listening');
    S.setBcPauseKeyListening(false);
    return;
  }
  // Ignore keybinds when typing in inputs
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  // Mute keybind toggle
  if (S.settings.muteKeybind && e.code === S.settings.muteKey && !e.repeat) {
    e.preventDefault();
    toggleMute();
  }
  // Broadcast pause keybind toggle
  if (S.settings.bcPauseKeybind && e.code === S.settings.bcPauseKey && !e.repeat) {
    e.preventDefault();
    onBroadcastPauseToggle();
  }
  // PTT transmit
  if (S.settings.pushToTalk && e.code === S.settings.pttKey && !e.repeat) {
    if (!S.pttActive) { S.setPttActive(true); setPTTTransmit(true); }
  }
});

document.addEventListener('keyup', e => {
  if (S.settings.pushToTalk && e.code === S.settings.pttKey && S.pttActive) {
    S.setPttActive(false); setPTTTransmit(false);
  }
});

// ── Admin password enter key ──
document.getElementById('admin-pass-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAdminPassword();
});

// ── Listen for device changes (hot-swap) ──
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    populateDeviceList();
  });
}

// ── Touch to resume audio context ──
document.addEventListener('touchstart', () => {
  if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();
  if (S.playbackCtx && S.playbackCtx.state === 'suspended') S.playbackCtx.resume();
}, { passive: true });
