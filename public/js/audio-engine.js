// ── Audio Engine ──
// All Web Audio API logic: initAudio, initVAD, initRNNoise, buildAudioPipeline, Opus
import * as S from './state.js';
import { socket } from './socket-client.js';
import { notify } from './utils.js';
import { updateMyCard, applyOutputDevice, populateDeviceList, updatePTTButton } from './ui-controller.js';

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_FRAME_MS    = 20;
const DISCORD_FRAME_SIZE  = DISCORD_SAMPLE_RATE * DISCORD_FRAME_MS / 1000; // 960

/* ── RNNoise noise suppression ── */
const RNNOISE_FRAME_SIZE = 480; // RNNoise processes 480-sample frames (10ms @ 48kHz)

export async function initRNNoise() {
  try {
    if (typeof createRNNWasmModule !== 'function') {
      console.warn('[RNNoise] Module not available, skipping noise suppression');
      return;
    }
    const mod = await createRNNWasmModule({
      locateFile: (file) => '/voice/rnnoise/' + file
    });
    mod._rnnoise_init();
    const state = mod._rnnoise_create();
    if (!state) throw new Error('rnnoise_create returned null');
    const inPtr  = mod._malloc(RNNOISE_FRAME_SIZE * 4); // 480 float32s
    const outPtr = mod._malloc(RNNOISE_FRAME_SIZE * 4);
    if (!inPtr || !outPtr) throw new Error('Failed to allocate WASM memory');
    S.setRnnoiseModule(mod);
    S.setRnnoiseState(state);
    S.setRnnoiseInputPtr(inPtr);
    S.setRnnoiseOutputPtr(outPtr);
    console.log('[RNNoise] Noise suppression initialized ✓');
  } catch (e) {
    console.warn('[RNNoise] Failed to initialize, continuing without noise suppression:', e);
    S.setRnnoiseModule(null);
    S.setRnnoiseState(null);
  }
}

function denoiseFrame(i16Frame) {
  if (!S.rnnoiseState) return i16Frame;
  const len = i16Frame.length;
  const f32 = new Float32Array(len);
  for (let i = 0; i < len; i++) f32[i] = i16Frame[i]; // RNNoise expects float32 in [-32768, 32767]
  const heapF32 = S.rnnoiseModule.HEAPF32;
  const inOff   = S.rnnoiseInputPtr  >> 2;
  const outOff  = S.rnnoiseOutputPtr >> 2;
  for (let offset = 0; offset < len; offset += RNNOISE_FRAME_SIZE) {
    const remaining = len - offset;
    if (remaining < RNNOISE_FRAME_SIZE) break; // skip incomplete tail
    heapF32.set(f32.subarray(offset, offset + RNNOISE_FRAME_SIZE), inOff);
    S.rnnoiseModule._rnnoise_process_frame(S.rnnoiseState, S.rnnoiseOutputPtr, S.rnnoiseInputPtr);
    const processed = heapF32.subarray(outOff, outOff + RNNOISE_FRAME_SIZE);
    for (let j = 0; j < RNNOISE_FRAME_SIZE; j++) f32[offset + j] = processed[j];
  }
  const result = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const v = f32[i];
    result[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
  }
  return result;
}

const WORKLET_CODE = `
class DiscordCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._frameSize = options.processorOptions.frameSize;
    this._buf       = new Float32Array(this._frameSize * 2);
    this._writePos  = 0;
    this._active    = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this._active = false; };
  }
  process(inputs) {
    if (!this._active) return false;
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    let rmsSum = 0;
    for (let i = 0; i < ch.length; i++) rmsSum += ch[i] * ch[i];
    const rms = Math.sqrt(rmsSum / ch.length);
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._writePos++] = ch[i];
      if (this._writePos >= this._frameSize) {
        const frame = new Int16Array(this._frameSize);
        for (let j = 0; j < this._frameSize; j++) {
          const s = this._buf[j];
          frame[j] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
        }
        this.port.postMessage({ type: 'frame', data: frame.buffer, rms }, [frame.buffer]);
        this._writePos = 0;
      }
    }
    return true;
  }
}
registerProcessor('discord-capture', DiscordCapture);
`;

export async function buildAudioPipeline() {
  if (!S.audioCtx) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate:  DISCORD_SAMPLE_RATE,
      latencyHint: 'interactive'
    });
    S.setAudioCtx(ctx);
    S.setSAMPLE_RATE(ctx.sampleRate);
  }
  if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();

  S.setSourceNode(S.audioCtx.createMediaStreamSource(S.localStream));
  const gainNode = S.audioCtx.createGain();
  gainNode.gain.value = S.settings.inputVolume / 100;
  S.setInputGainNode(gainNode);
  S.sourceNode.connect(S.inputGainNode);

  let useWorklet = false;
  if (S.audioCtx.audioWorklet) {
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await S.audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      useWorklet = true;
    } catch(e) {
      console.warn('[Audio] AudioWorklet failed, falling back to ScriptProcessor:', e);
    }
  }

  if (useWorklet) {
    const node = new AudioWorkletNode(S.audioCtx, 'discord-capture', {
      processorOptions: { frameSize: DISCORD_FRAME_SIZE },
      numberOfInputs:  1,
      numberOfOutputs: 0,
      channelCount:    1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete'
    });
    node.port.onmessage = (e) => {
      if (e.data.type !== 'frame') return;
      _handleCaptureFrame(new Int16Array(e.data.data), e.data.rms);
    };
    S.inputGainNode.connect(node);
    S.setProcessorNode(node);
  } else {
    const node = S.audioCtx.createScriptProcessor(256, 1, 1);
    let _spBuf   = new Float32Array(DISCORD_FRAME_SIZE * 2);
    let _spWrite = 0;
    node.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      let rmsSum = 0;
      for (let i = 0; i < ch.length; i++) rmsSum += ch[i] * ch[i];
      const rms = Math.sqrt(rmsSum / ch.length);
      for (let i = 0; i < ch.length; i++) {
        _spBuf[_spWrite++] = ch[i];
        if (_spWrite >= DISCORD_FRAME_SIZE) {
          const frame = new Int16Array(DISCORD_FRAME_SIZE);
          for (let j = 0; j < DISCORD_FRAME_SIZE; j++) {
            const s = _spBuf[j];
            frame[j] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
          }
          _handleCaptureFrame(frame, rms);
          _spWrite = 0;
        }
      }
    };
    S.inputGainNode.connect(node);
    node.connect(S.audioCtx.destination);
    S.setProcessorNode(node);
  }

  if (S.settings.pushToTalk || S.settings.pttTouch) S.localStream.getAudioTracks().forEach(t => t.enabled = false);
  updatePTTButton();

  // Initialize Opus encoder if WebCodecs is supported
  if (S.useWebCodecs && !S.opusEncoder) {
    try {
      const encoder = new AudioEncoder({
        output: (chunk, metadata) => {
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);
          socket.volatile.emit('audio-chunk', {
            rate: 48000,
            codec: 'opus',
            data: buf,
            seq: S.incrementSeqCounter()
          });
        },
        error: (e) => {
          console.warn('[Opus] Encoder error:', e);
          S.setOpusEncoder(null);
        }
      });
      encoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 1,
        bitrate: 24000
      });
      S.setOpusEncoder(encoder);
      console.log('[Opus] Encoder initialized ✓');
    } catch (e) {
      console.warn('[Opus] Could not initialize encoder, falling back to PCM:', e);
      S.setOpusEncoder(null);
    }
  }
}

function _handleCaptureFrame(i16Frame, rms) {
  const gainedRms = rms * (S.settings.inputVolume / 100);
  S.setLastRmsEnergy(gainedRms);

  if (!S.micVAD && !S.settings.pushToTalk && !S.settings.pttTouch && !S.isMuted) {
    const newSmoothed = gainedRms > S.smoothedEnergy
      ? gainedRms * 0.85 + S.smoothedEnergy * 0.15
      : gainedRms * 0.02 + S.smoothedEnergy * 0.98;
    S.setSmoothedEnergy(newSmoothed);
    const threshold    = 0.05 * Math.pow(0.003 / 0.05, S.settings.micSensitivity / 100);
    const attackNeeded = S.settings.micSensitivity <= 25 ? 6 : 4;
    if (S.smoothedEnergy > threshold) {
      S.setVadAttackCount(S.vadAttackCount + 1);
      clearTimeout(S.vadHoldTimer);
      if (S.vadAttackCount >= attackNeeded && !S.vadActive) {
        S.setVadActive(true);
        if (!S.amISpeaking) { S.setAmISpeaking(true); updateMyCard(); }
      }
    } else {
      S.setVadAttackCount(0);
      if (S.vadActive) {
        clearTimeout(S.vadHoldTimer);
        S.setVadHoldTimer(setTimeout(() => { S.setVadActive(false); S.setAmISpeaking(false); updateMyCard(); }, 500));
      }
    }
  }

  if (!S.currentParty && !S.isBroadcaster) return;
  if (S.serverMutedMe) return;
  if (S.settings.pushToTalk || S.settings.pttTouch) {
    if (!S.pttActive) return;
  } else {
    const track = S.localStream?.getAudioTracks()[0];
    if (!track?.enabled || !S.vadActive) return;
  }

  const outFrame = S.settings.noiseCancelation !== false ? denoiseFrame(i16Frame) : i16Frame;
  if (S.useWebCodecs && S.opusEncoder && S.opusEncoder.state === 'configured') {
    const f32 = new Float32Array(outFrame.length);
    for (let i = 0; i < outFrame.length; i++) f32[i] = outFrame[i] / (outFrame[i] < 0 ? 0x8000 : 0x7FFF);
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: outFrame.length,
      numberOfChannels: 1,
      timestamp: S.encoderTimestamp,
      data: f32
    });
    S.addEncoderTimestamp(DISCORD_FRAME_MS * 1000);
    S.opusEncoder.encode(ad);
    ad.close();
  } else {
    socket.volatile.emit('audio-chunk', { rate: S.SAMPLE_RATE, codec: 'pcm', data: outFrame.buffer, seq: S.incrementSeqCounter() });
  }
}

export function int16ToFloat32(i16) {
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7FFF);
  return f32;
}

const JITTER_MIN   = 0.020;
const JITTER_MAX   = 0.150;
const JITTER_ALPHA = 0.05;

export function getPlaybackCtx() {
  if (!S.playbackCtx || S.playbackCtx.state === 'closed') {
    const opts = { sampleRate: DISCORD_SAMPLE_RATE, latencyHint: 'interactive' };
    if (S.selectedOutputDeviceId) opts.sinkId = S.selectedOutputDeviceId;
    S.setPlaybackCtx(new (window.AudioContext || window.webkitAudioContext)(opts));
  }
  if (S.playbackCtx.state === 'suspended') S.playbackCtx.resume();
  return S.playbackCtx;
}

export function handleAudioFrom({ from, chunk }) {
  if (S.isDeafened || S.localMuted[from]) return;

  const ctx        = getPlaybackCtx();
  const senderRate = chunk.rate || DISCORD_SAMPLE_RATE;
  const codec      = chunk.codec || 'pcm';
  const audioData  = chunk.data;
  const seq        = chunk.seq;

  if (!S.peerPlayers[from]) {
    const gainNode = ctx.createGain();
    gainNode.gain.value = (S.localVolume[from] ?? 100) / 100;
    gainNode.connect(ctx.destination);
    S.peerPlayers[from] = {
      gainNode,
      nextTime:     0,
      jitterTarget: JITTER_MIN * 2,
      lastArrival:  0,
      jitterEwma:   0,
      silenceTimer: null
    };
  }

  const peer = S.peerPlayers[from];

  function _scheduleBuf(buf) {
    const now = ctx.currentTime;
    if (peer.lastArrival > 0) {
      const instantJitter = Math.abs((now - peer.lastArrival) - DISCORD_FRAME_MS / 1000);
      peer.jitterEwma = peer.jitterEwma * (1 - JITTER_ALPHA) + instantJitter * JITTER_ALPHA;
      peer.jitterTarget = Math.min(JITTER_MAX, Math.max(JITTER_MIN, peer.jitterEwma * 2));
    }
    peer.lastArrival = now;

    const frameDur = buf.duration;
    const isFirst  = peer.nextTime === 0;
    const underrun = peer.nextTime < now - frameDur * 0.5;
    const overrun  = peer.nextTime > now + JITTER_MAX;

    if (isFirst || underrun || overrun) {
      peer.nextTime = now + peer.jitterTarget;
    } else if (peer.nextTime < now + frameDur * 0.25) {
      peer.nextTime += frameDur * 0.5;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(peer.gainNode);
    src.start(peer.nextTime);
    peer.nextTime += frameDur;

    showPeerSpeaking(from, true);
    clearTimeout(peer.silenceTimer);
    peer.silenceTimer = setTimeout(() => {
      showPeerSpeaking(from, false);
      if (S.peerPlayers[from]) S.peerPlayers[from].nextTime = 0;
    }, 350);
  }

  // ── Sequence number tracking & packet loss concealment ──
  if (seq != null) {
    if (!(from in S.peerLastSeq)) S.peerLastSeq[from] = -1;
    if (seq <= S.peerLastSeq[from]) return;
    const gap = seq - S.peerLastSeq[from] - 1;
    if (gap > 0) {
      const silentCount = Math.min(gap, 3);
      for (let s = 0; s < silentCount; s++) {
        const silentBuf = ctx.createBuffer(1, DISCORD_FRAME_SIZE, DISCORD_SAMPLE_RATE);
        _scheduleBuf(silentBuf);
      }
    }
    S.peerLastSeq[from] = seq;
  }

  if (codec !== 'pcm') {
    // ── Opus decoding via WebCodecs AudioDecoder ──
    if (codec === 'opus' && S.useWebCodecs) {
      if (!S.peerDecoders[from]) {
        try {
          const decoder = new AudioDecoder({
            output: (decodedData) => {
              const numFrames = decodedData.numberOfFrames;
              const buf = ctx.createBuffer(1, numFrames, decodedData.sampleRate);
              const f32 = new Float32Array(numFrames);
              decodedData.copyTo(f32, { planeIndex: 0 });
              buf.copyToChannel(f32, 0);
              decodedData.close();
              _scheduleBuf(buf);
            },
            error: (e) => {
              console.warn('[Opus] Decoder error for', from, ':', e);
              try { S.peerDecoders[from]?.close(); } catch(ex) { console.warn('[Opus] Decoder close failed:', ex); }
              delete S.peerDecoders[from];
            }
          });
          decoder.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: 1
          });
          S.peerDecoders[from] = decoder;
        } catch (e) {
          console.warn('[Opus] Could not create decoder for', from, ':', e);
        }
      }
      if (S.peerDecoders[from] && S.peerDecoders[from].state !== 'closed') {
        try {
          const encodedChunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: (seq || 0) * DISCORD_FRAME_MS * 1000,
            data: audioData
          });
          S.peerDecoders[from].decode(encodedChunk);
        } catch (e) { /* decode error — stale/partial frame dropped, same as decodeAudioData .catch */ }
        return;
      }
    }

    // Fallback for non-PCM codecs without WebCodecs decoder
    ctx.decodeAudioData(audioData.slice(0)).then(decoded => {
      _scheduleBuf(decoded);
    }).catch(() => {}); // stale/partial frames are fine to drop
    return;
  }

  // PCM fallback path
  const i16  = new Int16Array(audioData);
  const f32  = int16ToFloat32(i16);

  const numSamples = senderRate === DISCORD_SAMPLE_RATE
    ? f32.length
    : Math.round(f32.length * DISCORD_SAMPLE_RATE / senderRate);

  const buf = ctx.createBuffer(1, numSamples, DISCORD_SAMPLE_RATE);

  if (senderRate === DISCORD_SAMPLE_RATE) {
    buf.copyToChannel(f32, 0);
  } else {
    const ratio = (f32.length - 1) / (numSamples - 1);
    const ch    = buf.getChannelData(0);
    for (let i = 0; i < numSamples; i++) {
      const pos  = i * ratio;
      const lo   = pos | 0;
      const hi   = Math.min(lo + 1, f32.length - 1);
      ch[i] = f32[lo] + (f32[hi] - f32[lo]) * (pos - lo);
    }
  }

  _scheduleBuf(buf);
}

export function showPeerSpeaking(sid, speaking) {
  const card = document.getElementById(`card-${sid}`);
  if (!card) return;
  card.classList.toggle('speaking', speaking && !S.localMuted[sid]);
  const tags = card.querySelector('.member-tags');
  if (!tags) return;
  const el = tags.querySelector('.tag-speaking');
  if (speaking && !el && !S.localMuted[sid]) { const t=document.createElement('span'); t.className='tag tag-speaking'; t.textContent='Speaking'; tags.prepend(t); }
  else if ((!speaking||S.localMuted[sid]) && el) el.remove();
}

export function removePeerPlayer(sid) {
  if (S.peerPlayers[sid]) {
    try { S.peerPlayers[sid].gainNode.disconnect(); } catch(e){}
    clearTimeout(S.peerPlayers[sid].silenceTimer);
    delete S.peerPlayers[sid];
  }
  if (S.peerDecoders[sid]) {
    try { S.peerDecoders[sid].close(); } catch(e){ console.warn('[Opus] Decoder cleanup failed:', e); }
    delete S.peerDecoders[sid];
  }
  delete S.peerLastSeq[sid];
}

export async function initAudio() {
  try {
    const audioConstraints = {
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl:  true
    };
    if (S.selectedInputDeviceId) audioConstraints.deviceId = { exact: S.selectedInputDeviceId };
    try {
      S.setLocalStream(await navigator.mediaDevices.getUserMedia({
        audio: {
          ...audioConstraints,
          channelCount:     1,
          sampleRate:       48000,
          latency:          0.01
        },
        video: false
      }));
    } catch (constraintErr) {
      // Fallback for mobile browsers that may not support all constraints
      console.warn('Audio constraints (channelCount/sampleRate/latency) not supported, retrying without them:', constraintErr);
      S.setLocalStream(await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      }));
    }
    await buildAudioPipeline();
    initRNNoise(); // non-blocking; falls back gracefully if unavailable
    notify('Microphone ready', 'success');
    // initVAD requires localStream — call it only after getUserMedia resolves
    initVAD();
    // Populate device list after permission is granted (labels become available)
    populateDeviceList();
    // Apply saved output device
    applyOutputDevice();
  } catch(e) {
    notify('Microphone access denied', 'error');
  }
}

export async function initVAD() {
  let waited = 0;
  while ((!window.vad || !window.vad.MicVAD) && waited < 5000) {
    await new Promise(r => setTimeout(r, 100));
    waited += 100;
  }
  if (!window.vad || !window.vad.MicVAD) {
    console.warn('[VAD] vad-web not available, falling back to energy VAD');
    return;
  }
  try {
    const sens = S.settings.micSensitivity;
    const initPosThresh = 0.92 - (sens / 100) * 0.77;
    const initNegThresh = Math.max(0.10, initPosThresh - 0.15);
    const initMinFrames = sens <= 25 ? 6 : (sens <= 50 ? 4 : 3);

    const vadProcessorType = (typeof AudioWorkletNode !== 'undefined') ? 'AudioWorklet' : 'ScriptProcessor';
    const vad = await window.vad.MicVAD.new({
      getStream:    async () => S.localStream,
      pauseStream:  async () => {},
      resumeStream: async () => S.localStream,
      processorType: vadProcessorType,
      baseAssetPath:    '/voice/vad/',
      onnxWASMBasePath: '/voice/vad/',
      model: 'legacy',
      positiveSpeechThreshold: initPosThresh,
      negativeSpeechThreshold: initNegThresh,
      minSpeechFrames: initMinFrames,
      preSpeechPadFrames: 5,
      redemptionFrames: 8,
      onSpeechStart: () => {
        if (S.isMuted || S.settings.pushToTalk || S.settings.pttTouch) return;
        // Only apply energy floor check when we actually have a reading
        if (S.lastRmsEnergy > 0) {
          const energyFloor = 0.025 * Math.pow(0.003 / 0.025, S.settings.micSensitivity / 100);
          if (S.lastRmsEnergy < energyFloor) return;
        }
        clearTimeout(S.vadHoldTimer);
        S.setVadActive(true);
        if (!S.amISpeaking) { S.setAmISpeaking(true); updateMyCard(); }
      },
      onSpeechEnd: () => {
        if (S.settings.pushToTalk || S.settings.pttTouch) return;
        clearTimeout(S.vadHoldTimer);
        S.setVadHoldTimer(setTimeout(() => {
          S.setVadActive(false);  // ← stops transmission gate
          S.setAmISpeaking(false);
          updateMyCard();
        }, 300));
      },
      onVADMisfire: () => {
        clearTimeout(S.vadHoldTimer);
        S.setVadActive(false);
        S.setAmISpeaking(false);
        updateMyCard();
      }
    });
    await vad.start();
    S.setMicVAD(vad);
    console.log('[VAD] Silero VAD running ✓');
  } catch(e) {
    console.warn('[VAD] Failed to init, falling back to energy VAD:', e);
    S.setMicVAD(null);
  }
}

export async function switchMicrophone(deviceId) {
  try {
    // Build constraints
    const audioConstraints = { noiseSuppression: true, echoCancellation: true, autoGainControl: true };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: { ...audioConstraints, channelCount: 1, sampleRate: 48000, latency: 0.01 },
        video: false
      });
    } catch (constraintErr) {
      console.warn('[Devices] Advanced constraints not supported, retrying:', constraintErr);
      newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    }

    // Preserve mute / PTT state
    const wasMuted = S.isMuted || S.settings.pushToTalk || S.settings.pttTouch;

    // Stop old tracks
    if (S.localStream) S.localStream.getTracks().forEach(t => t.stop());

    // Tear down old source node only (keep audioCtx and processor intact)
    if (S.sourceNode) { try { S.sourceNode.disconnect(); } catch(e){ console.warn('[Devices] sourceNode disconnect:', e); } S.setSourceNode(null); }

    S.setLocalStream(newStream);

    // Reconnect into existing pipeline
    if (S.audioCtx && S.inputGainNode) {
      S.setSourceNode(S.audioCtx.createMediaStreamSource(S.localStream));
      S.sourceNode.connect(S.inputGainNode);
    }

    // Restore track enabled state
    if (wasMuted) S.localStream.getAudioTracks().forEach(t => t.enabled = false);

    // Re-init VAD with new stream
    if (S.micVAD) { try { S.micVAD.destroy(); } catch(e){ console.warn('[Devices] VAD cleanup:', e); } S.setMicVAD(null); }
    initVAD();

    notify('Microphone switched ✓', 'success');
  } catch (e) {
    console.error('[Devices] Failed to switch microphone:', e);
    notify('Could not switch microphone', 'error');
  }
}
