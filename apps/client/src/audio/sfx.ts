/** Synthetic SFX using Web Audio API — fallback when MP3 files are absent. */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

type SFXDef = (ctx: AudioContext, vol: number) => void;

function shoot(c: AudioContext, vol: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(440, c.currentTime);
  osc.frequency.linearRampToValueAtTime(880, c.currentTime + 0.05);
  gain.gain.setValueAtTime(vol * 0.7, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.05);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.05);
}

function hit(c: AudioContext, vol: number) {
  // Noise burst via buffer
  const len = Math.floor(c.sampleRate * 0.08);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  gain.gain.setValueAtTime(vol * 0.7, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.08);
  src.connect(gain).connect(c.destination);
  src.start();
  // Low sine thud
  const osc = c.createOscillator();
  const g2 = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(200, c.currentTime);
  g2.gain.setValueAtTime(vol * 0.6, c.currentTime);
  g2.gain.linearRampToValueAtTime(0, c.currentTime + 0.08);
  osc.connect(g2).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.08);
}

function death(c: AudioContext, vol: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(600, c.currentTime);
  osc.frequency.linearRampToValueAtTime(100, c.currentTime + 0.3);
  gain.gain.setValueAtTime(vol * 0.6, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.3);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.3);
}

function pickup(c: AudioContext, vol: number) {
  const notes = [400, 533, 667, 800];
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    const t = c.currentTime + i * 0.04;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(vol * 0.5, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.04);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.04);
  });
}

function matchStart(c: AudioContext, vol: number) {
  // C-E-G chord
  const freqs = [261.6, 329.6, 392.0];
  for (const freq of freqs) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, c.currentTime);
    gain.gain.setValueAtTime(vol * 0.4, c.currentTime);
    gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.2);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.2);
  }
}

function explosion(c: AudioContext, vol: number) {
  // Low boom + noise burst
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, c.currentTime);
  osc.frequency.linearRampToValueAtTime(30, c.currentTime + 0.25);
  gain.gain.setValueAtTime(vol * 0.8, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.25);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.25);
  // Noise crackle
  const len = Math.floor(c.sampleRate * 0.15);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g2 = c.createGain();
  g2.gain.setValueAtTime(vol * 0.6, c.currentTime);
  g2.gain.linearRampToValueAtTime(0, c.currentTime + 0.15);
  src.connect(g2).connect(c.destination);
  src.start();
}

function jump(c: AudioContext, vol: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, c.currentTime);
  osc.frequency.linearRampToValueAtTime(500, c.currentTime + 0.08);
  gain.gain.setValueAtTime(vol * 0.4, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.08);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.08);
}

function matchEnd(c: AudioContext, vol: number) {
  // Descending C-G-E
  const notes = [523.3, 392.0, 329.6];
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    const t = c.currentTime + i * 0.1;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(vol * 0.4, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.1);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  });
}

const SFX_MAP: Record<string, SFXDef> = {
  shoot,
  hit,
  death,
  pickup,
  jump,
  explosion,
  "match-start": matchStart,
  "match-end": matchEnd,
};

export function playSFX(key: string, volume: number) {
  const fn = SFX_MAP[key];
  if (!fn) return;
  try {
    const c = getCtx();
    if (c.state === "suspended") c.resume();
    fn(c, volume);
  } catch {
    // Web Audio not available
  }
}
