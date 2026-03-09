// ── Utility / helper functions ──

export function esc(str) {
  if (str == null) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

export function setErr(id, msg) {
  document.getElementById(id).textContent = msg;
}

export function notify(msg, type = '') {
  const el = document.createElement('div');
  el.className = `notif${type?' '+type:''}`;
  el.textContent = msg;
  document.getElementById('notifications').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

export function latencyClass(ms) {
  if (ms == null) return '';
  if (ms < 100) return 'latency-good';
  if (ms <= 200) return 'latency-medium';
  return 'latency-bad';
}

import * as S from './state.js';

let sfxCtxLocal = null;

function getSfxCtx() {
  if (!sfxCtxLocal || sfxCtxLocal.state === 'closed') {
    const opts = S.selectedOutputDeviceId ? { sinkId: S.selectedOutputDeviceId } : {};
    sfxCtxLocal = new (window.AudioContext || window.webkitAudioContext)(opts);
    S.setSfxCtx(sfxCtxLocal);
  }
  if (sfxCtxLocal.state === 'suspended') sfxCtxLocal.resume();
  return sfxCtxLocal;
}

export function playSound(type) {
  try {
    const ctx = getSfxCtx();
    const now = ctx.currentTime;

    if (type === 'join') {
      // Two-tone ascending chime — clean, modern
      [[660, 0, 0.08], [880, 0.1, 0.08]].forEach(([freq, delay, dur]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(0.18, now + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur + 0.15);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + delay); osc.stop(now + delay + dur + 0.18);
      });

    } else if (type === 'leave') {
      // Single low descending tone — hollow, distinct from join
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.2);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.35);

    } else if (type === 'ptt-on') {
      // Short click-on — single high tick
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.exponentialRampToValueAtTime(900, now + 0.04);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.07);

    } else if (type === 'ptt-off') {
      // Short click-off — lower tick
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(900, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.04);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.07);

    } else if (type === 'mute') {
      // Short descending pop — muting
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.08);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.15);

    } else if (type === 'unmute') {
      // Short ascending pop — unmuting
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.15);

    } else if (type === 'deafen') {
      // Double descending pop — deafening  [freq, delay, duration]
      [[480, 0, 0.06], [340, 0.07, 0.06]].forEach(([freq, delay, dur]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(0.14, now + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur + 0.08);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + delay); osc.stop(now + delay + dur + 0.12);
      });

    } else if (type === 'undeafen') {
      // Double ascending pop — undeafening  [freq, delay, duration]
      [[400, 0, 0.06], [560, 0.07, 0.06]].forEach(([freq, delay, dur]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(0.14, now + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur + 0.08);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + delay); osc.stop(now + delay + dur + 0.12);
      });
    }
  } catch(e) { /* audio unavailable */ }
}
