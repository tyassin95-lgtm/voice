// ── Global application state ──
// All state variables that were previously globals in the monolithic index.html

export let myUsername    = '';
export let myPassword    = '';   // only set for registered users
export let isGuest       = true;
export let currentParty  = null;
export let isBroadcaster = false;
export let isMuted       = false;
export let isDeafened    = false;
export let isAdmin       = false;
export let myRole        = 'user'; // 'user', 'admin', or 'owner'
export let ownerCode     = '';     // stored when owner code is verified
export let serverMutedMe = false;
export let localStream   = null;
export let partyData     = {};
export let amISpeaking   = false;

// ── Latency tracking ──
export const peerLatency = {};   // socketId → latency in ms
export let myLatency     = null; // own latency in ms
export let pingInterval  = null; // interval handle

export let settings = {
  micSensitivity:   50,
  pushToTalk:       false,
  pttKey:           'Space',
  pttTouch:         false,
  muteKeybind:      false,
  muteKey:          'KeyM',
  bcPauseKeybind:   false,
  bcPauseKey:       'KeyB',
  inputVolume:      100,
  noiseCancelation: true
};

export let pttActive           = false;
export let pttListening        = false;
export let muteKeyListening    = false;
export let bcPauseKeyListening = false;
export let inputGainNode       = null;
export let selectedInputDeviceId  = localStorage.getItem('voice_input_device_id') || '';
export let selectedOutputDeviceId = localStorage.getItem('voice_output_device_id') || '';

export let audioCtx      = null;
export let sourceNode    = null;
export let processorNode = null;
export let SAMPLE_RATE   = 48000;

export const peerPlayers = {};
export const localMuted  = {};
export const localVolume = {};
export let popoverTarget = null;

export const useWebCodecs = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
export let opusEncoder      = null;
export let seqCounter       = 0;
export let encoderTimestamp  = 0;
export const peerDecoders   = {};
export const peerLastSeq    = {};

// VAD state
export let vadActive       = false;
export let vadHoldTimer    = null;
export let vadAttackCount  = 0;
export let smoothedEnergy  = 0;
export let lastRmsEnergy   = 0;
export let micVAD          = null;

// RNNoise state
export let rnnoiseModule   = null;
export let rnnoiseState    = null;
export let rnnoiseInputPtr = 0;
export let rnnoiseOutputPtr = 0;

// Playback
export let playbackCtx = null;

// Sound effects
export let sfxCtx = null;

// Broadcast state
export let bcTargets      = 'all';
export let bcPaused       = false;
export let bcAllSelected  = true;
export let bcPartySelected = new Set();

// Admin management
export let mgmtSearchTimeout = null;

// ── Setters for mutable state ──
// Since ES6 module exports are live bindings but can only be mutated from the module that declares them,
// we provide setter functions.

export function setMyUsername(v)    { myUsername = v; }
export function setMyPassword(v)    { myPassword = v; }
export function setIsGuest(v)       { isGuest = v; }
export function setCurrentParty(v)  { currentParty = v; }
export function setIsBroadcaster(v) { isBroadcaster = v; }
export function setIsMuted(v)       { isMuted = v; }
export function setIsDeafened(v)    { isDeafened = v; }
export function setIsAdmin(v)       { isAdmin = v; }
export function setMyRole(v)        { myRole = v; }
export function setOwnerCode(v)     { ownerCode = v; }
export function setServerMutedMe(v) { serverMutedMe = v; }
export function setLocalStream(v)   { localStream = v; }
export function setPartyData(v)     { partyData = v; }
export function setAmISpeaking(v)   { amISpeaking = v; }
export function setMyLatency(v)     { myLatency = v; }
export function setPingInterval(v)  { pingInterval = v; }
export function setSettings(v)      { settings = v; }
export function setPttActive(v)     { pttActive = v; }
export function setPttListening(v)  { pttListening = v; }
export function setMuteKeyListening(v)    { muteKeyListening = v; }
export function setBcPauseKeyListening(v) { bcPauseKeyListening = v; }
export function setInputGainNode(v)       { inputGainNode = v; }
export function setSelectedInputDeviceId(v)  { selectedInputDeviceId = v; }
export function setSelectedOutputDeviceId(v) { selectedOutputDeviceId = v; }
export function setAudioCtx(v)      { audioCtx = v; }
export function setSourceNode(v)    { sourceNode = v; }
export function setProcessorNode(v) { processorNode = v; }
export function setSAMPLE_RATE(v)   { SAMPLE_RATE = v; }
export function setPopoverTarget(v) { popoverTarget = v; }
export function setOpusEncoder(v)   { opusEncoder = v; }
export function setSeqCounter(v)    { seqCounter = v; }
export function incrementSeqCounter() { return seqCounter++; }
export function setEncoderTimestamp(v) { encoderTimestamp = v; }
export function addEncoderTimestamp(v) { encoderTimestamp += v; }
export function setVadActive(v)     { vadActive = v; }
export function setVadHoldTimer(v)  { vadHoldTimer = v; }
export function setVadAttackCount(v) { vadAttackCount = v; }
export function setSmoothedEnergy(v) { smoothedEnergy = v; }
export function setLastRmsEnergy(v)  { lastRmsEnergy = v; }
export function setMicVAD(v)         { micVAD = v; }
export function setRnnoiseModule(v)   { rnnoiseModule = v; }
export function setRnnoiseState(v)    { rnnoiseState = v; }
export function setRnnoiseInputPtr(v) { rnnoiseInputPtr = v; }
export function setRnnoiseOutputPtr(v){ rnnoiseOutputPtr = v; }
export function setPlaybackCtx(v)    { playbackCtx = v; }
export function setSfxCtx(v)         { sfxCtx = v; }
export function setBcTargets(v)      { bcTargets = v; }
export function setBcPaused(v)       { bcPaused = v; }
export function setBcAllSelected(v)  { bcAllSelected = v; }
export function setBcPartySelected(v){ bcPartySelected = v; }
export function setMgmtSearchTimeout(v) { mgmtSearchTimeout = v; }

/* ═══ SVG ICON DEFINITIONS ═══ */
export const SVG_MIC_ON   = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V21c0 .55.45 1 1 1s1-.45 1-1v-3.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>';
export const SVG_MIC_OFF  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';
export const SVG_DEAF_ON  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/></svg>';
export const SVG_DEAF_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9z" opacity=".65"/><path d="M3.27 2L2 3.27 20.73 22 22 20.73z"/></svg>';
