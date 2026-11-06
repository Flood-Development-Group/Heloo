import { FRIC_BANDS, NUM_BANDS, type FrameParams } from './acoustic';

/** Deterministic xorshift32 noise in [-1, 1). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x80000000 - 1;
  }
}

const VOICED_LEVEL = 0.16;
const ASP_LEVEL = 0.14;
const FRIC_LEVEL = 0.22;

/** Magnitude of a 2-pole resonance at f, normalised to 1 at DC. */
function resonance(f: number, F: number, B: number): number {
  const h = B * 0.5;
  const h2 = h * h;
  const dm = f - F;
  const dp = f + F;
  return (F * F + h2) / Math.sqrt((dm * dm + h2) * (dp * dp + h2));
}

/**
 * Computes harmonic amplitudes (normalised to unit RMS) for one frame.
 * Returns the number of harmonics written.
 */
function harmonicAmps(p: FrameParams, k: number, fmax: number, out: Float64Array): number {
  const f0 = p.f0[k];
  const K = Math.min(out.length, Math.floor(fmax / f0));
  const tilt = p.tilt[k];
  const zd = p.zeroDepth[k];
  const zF = p.zeroF[k];
  const zB = p.zeroB[k];
  const F0 = p.F[0][k], F1 = p.F[1][k], F2 = p.F[2][k], F3 = p.F[3][k], F4 = p.F[4][k];
  const B0 = p.B[0][k], B1 = p.B[1][k], B2 = p.B[2][k], B3 = p.B[3][k], B4 = p.B[4][k];
  const taperStart = 0.75 * fmax;
  let energy = 0;
  for (let h = 1; h <= K; h++) {
    const f = h * f0;
    let a =
      resonance(f, F0, B0) * resonance(f, F1, B1) * resonance(f, F2, B2) * resonance(f, F3, B3) * resonance(f, F4, B4) * Math.pow(h, -tilt);
    if (zd > 0) a *= Math.pow(1 / resonance(f, zF, zB), zd);
    if (f > taperStart) a *= 0.5 * (1 + Math.cos((Math.PI * (f - taperStart)) / (fmax - taperStart)));
    out[h - 1] = a;
    energy += a * a;
  }
  const norm = energy > 0 ? 1 / Math.sqrt(energy / 2) : 0;
  for (let h = 0; h < K; h++) out[h] *= norm;
  for (let h = K; h < out.length; h++) out[h] = 0;
  return K;
}

class Resonator {
  y1 = 0;
  y2 = 0;
  a = 0;
  b = 0;
  c = 0;
  set(F: number, B: number, fs: number): void {
    const T = 1 / fs;
    this.c = -Math.exp(-2 * Math.PI * B * T);
    this.b = 2 * Math.exp(-Math.PI * B * T) * Math.cos(2 * Math.PI * F * T);
    this.a = 1 - this.b - this.c;
  }
  process(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class BandPass {
  private b0: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(fc: number, q: number, fs: number) {
    const w0 = (2 * Math.PI * Math.min(fc, fs * 0.45)) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Harmonic-plus-noise synthesis. Voiced sound is a sum of phase-locked harmonics whose
 * amplitudes follow the formant envelope (computed with a Chebyshev recurrence, so it is
 * band-limited and alias-free). Aspiration is noise through a formant cascade; frication is
 * noise through a fixed band bank.
 */
export function synthesize(p: FrameParams, sampleRate: number, seed: number): Float32Array {
  const hop = p.dt * sampleRate;
  const total = Math.max(0, Math.floor((p.n - 1) * hop));
  const out = new Float32Array(total);
  const fmax = Math.min(11000, sampleRate * 0.45);
  const maxK = Math.ceil(fmax / 30) + 1;
  let ampA = new Float64Array(maxK);
  let ampB = new Float64Array(maxK);
  const cur = new Float64Array(maxK);
  const delta = new Float64Array(maxK);
  const rng = new Rng(seed);
  const jitterRng = new Rng(seed ^ 0x5bd1e995);

  const asp = [new Resonator(), new Resonator(), new Resonator(), new Resonator(), new Resonator()];
  const bank = FRIC_BANDS.map((fc) => new BandPass(fc, 2.2, sampleRate));
  const bandGain = new Float64Array(NUM_BANDS);

  const tauA = 1 - Math.exp(-1 / (0.006 * sampleRate));
  const tauF = 1 - Math.exp(-1 / (0.002 * sampleRate));
  const tauH = 1 - Math.exp(-1 / (0.005 * sampleRate));
  const tauE = 1 - Math.exp(-1 / (0.03 * sampleRate));
  let av = 0;
  let ah = 0;
  let af = 0;
  let aspEnergy = 1e-6;
  let phase = 0;
  let prevNoise = 0;
  let dcX = 0;
  let dcY = 0;

  let kA = harmonicAmps(p, 0, fmax, ampA);
  let jitA = jitterRng.next();
  let shimA = jitterRng.next();
  for (let frame = 0; frame < p.n - 1; frame++) {
    const kB = harmonicAmps(p, frame + 1, fmax, ampB);
    const jitB = jitterRng.next();
    const shimB = jitterRng.next();
    const K = Math.max(kA, kB);
    const s0 = Math.floor(frame * hop);
    const s1 = Math.min(total, Math.floor((frame + 1) * hop));
    const len = s1 - s0;
    if (len <= 0) {
      [ampA, ampB] = [ampB, ampA];
      kA = kB;
      continue;
    }
    for (let h = 0; h < K; h++) {
      cur[h] = ampA[h];
      delta[h] = (ampB[h] - ampA[h]) / len;
    }
    for (let i = 0; i < 5; i++) asp[i].set(p.F[i][frame], p.B[i][frame] * 1.5, sampleRate);
    const f0a = p.f0[frame];
    const f0b = p.f0[frame + 1];
    const avT0 = p.av[frame], avT1 = p.av[frame + 1];
    const ahT0 = p.ah[frame], ahT1 = p.ah[frame + 1];
    const afT0 = p.af[frame], afT1 = p.af[frame + 1];
    const g0 = p.gain[frame], g1 = p.gain[frame + 1];

    for (let s = 0; s < len; s++) {
      const x = s / len;
      const jitter = 1 + 0.003 * (jitA + (jitB - jitA) * x);
      const f0 = (f0a + (f0b - f0a) * x) * jitter;
      phase += (2 * Math.PI * f0) / sampleRate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;

      // Harmonics via sin(k*phi) = 2cos(phi) sin((k-1)phi) - sin((k-2)phi).
      const c2 = 2 * Math.cos(phase);
      let sPrev = 0;
      let sCur = Math.sin(phase);
      let voiced = 0;
      for (let h = 0; h < K; h++) {
        voiced += cur[h] * sCur;
        cur[h] += delta[h];
        const sNext = c2 * sCur - sPrev;
        sPrev = sCur;
        sCur = sNext;
      }

      av += (avT0 + (avT1 - avT0) * x - av) * tauA;
      ah += (ahT0 + (ahT1 - ahT0) * x - ah) * tauH;
      af += (afT0 + (afT1 - afT0) * x - af) * tauF;
      for (let b = 0; b < NUM_BANDS; b++) {
        const target = p.bands[b][frame] + (p.bands[b][frame + 1] - p.bands[b][frame]) * x;
        bandGain[b] += (target - bandGain[b]) * tauF;
      }

      // Aspiration: pre-emphasised noise through the vocal-tract resonances, level-normalised.
      const white = rng.next();
      const pre = white - 0.9 * prevNoise;
      prevNoise = white;
      let a = pre;
      for (let i = 0; i < 5; i++) a = asp[i].process(a);
      aspEnergy += (a * a - aspEnergy) * tauE;
      a /= Math.sqrt(aspEnergy + 1e-12);
      // Breath noise is louder during the open phase of the glottal cycle.
      const glottal = 1 - 0.45 * Math.min(1, av) * (0.5 + 0.5 * Math.cos(phase));

      // Frication.
      const n2 = rng.next();
      let fr = 0;
      for (let b = 0; b < NUM_BANDS; b++) fr += bandGain[b] * bank[b].process(n2);

      const shimmer = 1 + 0.03 * (shimA + (shimB - shimA) * x);
      const gain = g0 + (g1 - g0) * x;
      const y = (voiced * av * shimmer * VOICED_LEVEL + a * ah * glottal * ASP_LEVEL + fr * af * FRIC_LEVEL * 1.8) * gain;

      // DC blocker.
      const yd = y - dcX + 0.995 * dcY;
      dcX = y;
      dcY = yd;
      out[s0 + s] = yd;
    }
    [ampA, ampB] = [ampB, ampA];
    kA = kB;
    jitA = jitB;
    shimA = shimB;
  }

  // Short fades at the buffer edges so phrases never click.
  const fade = Math.min(Math.floor(sampleRate * 0.005), Math.floor(total / 2));
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    out[i] *= g;
    out[total - 1 - i] *= g;
  }
  return out;
}
