import { sampleCurveSorted } from '../core/curves';
import type { CurvePoint, VoiceParams } from '../core/model';
import type { TempoMap } from '../core/time';
import { phonemeDef, type FricShape, type PhonemeDef } from '../voice/phonemes';
import { midiToHz, type PitchModel } from './pitch';
import type { PhSeg } from './timing';
import type { BuiltinVoice } from './voices';

/** Centre frequencies of the frication band bank (Hz). */
export const FRIC_BANDS = [1200, 2200, 3300, 4500, 6000, 8000] as const;
export const NUM_BANDS = FRIC_BANDS.length;

const SHAPES: Record<FricShape, number[]> = {
  s: [0, 0.02, 0.1, 0.4, 1.0, 0.8],
  sh: [0.05, 0.6, 1.0, 0.6, 0.3, 0.15],
  f: [0.25, 0.3, 0.35, 0.4, 0.45, 0.45],
  th: [0.2, 0.3, 0.3, 0.35, 0.4, 0.35],
  h: [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
  burstLabial: [0.8, 0.5, 0.3, 0.2, 0.15, 0.1],
  burstAlveolar: [0.1, 0.2, 0.4, 0.8, 1.0, 0.6],
  burstVelar: [0.4, 1.0, 0.7, 0.3, 0.2, 0.1],
};

// Normalise each shape to unit energy so `af` alone sets loudness.
for (const key of Object.keys(SHAPES) as FricShape[]) {
  const s = SHAPES[key];
  const norm = Math.sqrt(s.reduce((a, x) => a + x * x, 0)) || 1;
  SHAPES[key] = s.map((x) => x / norm);
}

const FRIC_LEVEL: Record<FricShape, number> = {
  s: 0.55,
  sh: 0.55,
  f: 0.22,
  th: 0.16,
  h: 0.2,
  burstLabial: 0.7,
  burstAlveolar: 0.8,
  burstVelar: 0.8,
};

export interface FrameParams {
  n: number;
  /** Time of frame 0 (seconds). */
  t0: number;
  /** Seconds per frame. */
  dt: number;
  f0: Float64Array;
  F: Float64Array[];
  B: Float64Array[];
  zeroF: Float64Array;
  zeroB: Float64Array;
  zeroDepth: Float64Array;
  av: Float64Array;
  ah: Float64Array;
  af: Float64Array;
  bands: Float64Array[];
  tilt: Float64Array;
  gain: Float64Array;
}

export interface AcousticInput {
  segs: readonly PhSeg[];
  pitch: PitchModel;
  curves: Record<'loudness' | 'breathiness' | 'gender' | 'tension', readonly CurvePoint[]>;
  tempo: TempoMap;
  voice: BuiltinVoice;
  voiceParams: VoiceParams;
  t0: number;
  t1: number;
  dt: number;
}

interface Target {
  def: PhonemeDef | null;
  /** Formants come from this definition (null: fill from neighbours). */
  formants: PhonemeDef | null;
  av: number;
  ah: number;
  af: number;
  shape: FricShape | null;
  zero: number;
  diphthongMix: number;
}

const SILENT: Target = { def: null, formants: null, av: 0, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };

function isFormantSource(d: PhonemeDef | undefined): boolean {
  return !!d && (d.cls === 'vowel' || d.cls === 'diphthong' || d.cls === 'nasal' || d.cls === 'liquid' || d.cls === 'glide');
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function targetFor(seg: PhSeg, t: number, nextVowel: PhonemeDef | null): Target {
  const d = phonemeDef(seg.ph);
  if (!d) return SILENT;
  const dur = seg.end - seg.start;
  const u = dur > 0 ? (t - seg.start) / dur : 0;
  const coda = seg.role === 'coda';
  switch (d.cls) {
    case 'vowel':
      return { def: d, formants: d, av: 1, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
    case 'diphthong': {
      // Hold the first vowel and glide to the second near the end.
      const glide = Math.min(0.2, 0.45 * dur);
      const mix = clamp((t - (seg.end - glide)) / Math.max(glide, 1e-3), 0, 1);
      return { def: d, formants: d, av: 1, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: mix * mix * (3 - 2 * mix) };
    }
    case 'nasal':
      return { def: d, formants: d, av: d.level, ah: 0, af: 0, shape: null, zero: 1, diphthongMix: 0 };
    case 'liquid':
    case 'glide':
      return { def: d, formants: d, av: d.level, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
    case 'flap':
      return { def: d, formants: d, av: d.level, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
    case 'fricative':
      return { def: d, formants: d, av: d.voiced ? d.level : 0, ah: 0, af: FRIC_LEVEL[d.fric ?? 's'] * (d.voiced ? 0.6 : 1), shape: d.fric ?? 's', zero: 0, diphthongMix: 0 };
    case 'aspirate': {
      if (seg.ph === 'br') {
        const env = Math.sin(Math.PI * clamp(u, 0, 1));
        return { def: d, formants: d, av: 0, ah: 0.35 * env, af: 0.05 * env, shape: 'h', zero: 0, diphthongMix: 0 };
      }
      return { def: d, formants: nextVowel ?? d, av: 0, ah: 0.55, af: FRIC_LEVEL.h, shape: 'h', zero: 0, diphthongMix: 0 };
    }
    case 'stop': {
      const closureEnd = coda ? 0.75 : 0.6;
      const burstLen = Math.min(0.015, 0.25 * dur) / Math.max(dur, 1e-3);
      if (u < closureEnd) return { def: d, formants: d, av: d.voiced ? d.level : 0, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
      if (u < closureEnd + burstLen) {
        const level = (d.voiced ? 0.55 : 1) * (coda ? 0.45 : 1) * FRIC_LEVEL[d.burst ?? 'burstAlveolar'];
        return { def: d, formants: d, av: d.voiced ? d.level : 0, ah: 0, af: level, shape: d.burst ?? 'burstAlveolar', zero: 0, diphthongMix: 0 };
      }
      if (coda) return { def: d, formants: d, av: 0, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
      if (d.voiced) return { def: d, formants: nextVowel ?? d, av: 0.45, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
      return { def: d, formants: nextVowel ?? d, av: 0, ah: 0.45, af: 0.05, shape: d.burst ?? 'h', zero: 0, diphthongMix: 0 };
    }
    case 'affricate': {
      const burstLen = Math.min(0.012, 0.15 * dur) / Math.max(dur, 1e-3);
      if (u < 0.35) return { def: d, formants: d, av: d.voiced ? 0.12 : 0, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
      if (u < 0.35 + burstLen) return { def: d, formants: d, av: d.voiced ? 0.3 : 0, ah: 0, af: FRIC_LEVEL[d.burst ?? 'burstAlveolar'], shape: d.burst ?? 'burstAlveolar', zero: 0, diphthongMix: 0 };
      return { def: d, formants: d, av: d.voiced ? d.level : 0, ah: 0, af: FRIC_LEVEL[d.fric ?? 'sh'] * (d.voiced ? 0.7 : 1), shape: d.fric ?? 'sh', zero: 0, diphthongMix: 0 };
    }
    case 'closure':
    default:
      return { def: d, formants: null, av: 0, ah: 0, af: 0, shape: null, zero: 0, diphthongMix: 0 };
  }
}

function gaussianSmooth(x: Float64Array, sigmaFrames: number): Float64Array {
  const r = Math.ceil(sigmaFrames * 3);
  const w: number[] = [];
  for (let i = -r; i <= r; i++) w.push(Math.exp(-(i * i) / (2 * sigmaFrames * sigmaFrames)));
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= x.length) continue;
      const wk = w[k + r];
      acc += wk * x[j];
      ws += wk;
    }
    out[i] = acc / ws;
  }
  return out;
}

/** Converts placed phonemes, pitch and parameter curves into per-frame synthesis controls. */
export function computeFrames(input: AcousticInput): FrameParams {
  const { segs, pitch, curves, tempo, voice, voiceParams: vp, t0, t1, dt } = input;
  const n = Math.max(2, Math.ceil((t1 - t0) / dt) + 2);
  const mk = () => new Float64Array(n);
  const F = [mk(), mk(), mk(), mk(), mk()];
  const B = [mk(), mk(), mk(), mk(), mk()];
  const has = new Uint8Array(n);
  const zeroF = mk();
  const zeroB = mk();
  const zeroDepth = mk();
  const av = mk();
  const ah = mk();
  const af = mk();
  const bands = Array.from({ length: NUM_BANDS }, mk);
  const tilt = mk();
  const gain = mk();
  const f0 = mk();

  // Next formant-bearing phoneme for each segment (for aspiration colouring).
  const nextVowel: (PhonemeDef | null)[] = segs.map((_, i) => {
    for (let j = i + 1; j < segs.length && segs[j].start - segs[i].end < 0.3; j++) {
      const d = phonemeDef(segs[j].ph);
      if (isFormantSource(d)) return d ?? null;
    }
    return null;
  });

  let si = 0;
  let zf = 0;
  let zb = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * dt;
    while (si < segs.length && segs[si].end <= t) si++;
    const seg = segs[si];
    const target = seg && seg.start <= t ? targetFor(seg, t, nextVowel[si]) : SILENT;
    const fd = target.formants;
    if (fd) {
      has[k] = 1;
      const mix = target.diphthongMix;
      for (let i = 0; i < 5; i++) {
        const a = fd.f[i];
        const b = fd.f2 ? fd.f2[i] : a;
        F[i][k] = a + (b - a) * mix;
        B[i][k] = fd.b[i];
      }
      if (fd.zero) {
        zf = fd.zero[0];
        zb = fd.zero[1];
      }
    }
    zeroF[k] = zf || 1000;
    zeroB[k] = zb || 200;
    zeroDepth[k] = target.zero;
    av[k] = target.av;
    ah[k] = target.ah;
    af[k] = target.af;
    if (target.shape) {
      const s = SHAPES[target.shape];
      for (let b = 0; b < NUM_BANDS; b++) bands[b][k] = s[b];
    }
  }

  // Fill frames without formant information: each silent run takes the formants of the
  // nearer neighbour, so formant jumps happen in the middle of silence.
  const copyFrame = (dst: number, src: number) => {
    for (let i = 0; i < 5; i++) {
      F[i][dst] = F[i][src];
      B[i][dst] = B[i][src];
    }
  };
  const first = firstHas(has);
  if (first >= n) {
    const neutral = [500, 1500, 2500, 3500, 4500];
    const nb = [60, 90, 120, 160, 200];
    for (let i = 0; i < 5; i++) {
      F[i].fill(neutral[i]);
      B[i].fill(nb[i]);
    }
  } else {
    for (let k = 0; k < first; k++) copyFrame(k, first);
    let k = first;
    while (k < n) {
      if (has[k]) {
        k++;
        continue;
      }
      const runStart = k;
      while (k < n && !has[k]) k++;
      const prevK = runStart - 1;
      const nextK = k < n ? k : -1;
      const mid = nextK < 0 ? n : (runStart + nextK) / 2;
      for (let j = runStart; j < (nextK < 0 ? n : nextK); j++) copyFrame(j, j < mid || nextK < 0 ? prevK : nextK);
    }
  }
  // Smooth band gains a little so fricative spectra cross-fade.
  for (let b = 0; b < NUM_BANDS; b++) bands[b] = gaussianSmooth(bands[b], 1.0);
  const sigma = 0.012 / dt;
  for (let i = 0; i < 5; i++) {
    F[i] = gaussianSmooth(F[i], sigma);
    B[i] = gaussianSmooth(B[i], sigma);
  }

  // Curves and pitch.
  const ticks = mk();
  for (let k = 0; k < n; k++) ticks[k] = tempo.secToTick(t0 + k * dt);
  const loud = mk();
  const breath = mk();
  const gender = mk();
  const tension = mk();
  sampleCurveSorted(curves.loudness, ticks, 0, loud);
  sampleCurveSorted(curves.breathiness, ticks, 0, breath);
  sampleCurveSorted(curves.gender, ticks, 0, gender);
  sampleCurveSorted(curves.tension, ticks, 0, tension);
  const midi = mk();
  pitch.fill(t0, dt, midi);

  for (let k = 0; k < n; k++) {
    const hz = midiToHz(midi[k]);
    f0[k] = clamp(hz, 30, 2000);
    const g = clamp(vp.gender + gender[k], -1, 1);
    const ten = clamp(vp.tension + tension[k], -1, 1);
    const br = clamp(vp.breathiness + breath[k], -1, 1);
    const scale = voice.formantScale * Math.pow(2, -0.2 * g);
    const bwScale = 1 - 0.25 * ten;
    for (let i = 0; i < 5; i++) {
      F[i][k] *= scale;
      B[i][k] *= bwScale;
    }
    // Formant tuning: singers raise F1 above f0 at high pitches.
    if (F[0][k] < f0[k] * 1.08) F[0][k] = f0[k] * 1.08;
    for (let i = 1; i < 5; i++) if (F[i][k] < F[i - 1][k] + 150) F[i][k] = F[i - 1][k] + 150;
    zeroF[k] *= scale;
    tilt[k] = voice.tilt + 0.3 * Math.max(0, br) - 0.35 * ten;
    // Breathiness adds aspiration to voiced sound.
    const breathAmt = voice.breath * (br >= 0 ? 1 + 1.6 * br : 1 + br);
    ah[k] += av[k] * breathAmt * 0.6;
    gain[k] = Math.pow(10, loud[k] / 20) * voice.gain;
  }

  return { n, t0, dt, f0, F, B, zeroF, zeroB, zeroDepth, av, ah, af, bands, tilt, gain };
}

function firstHas(has: Uint8Array): number {
  for (let k = 0; k < has.length; k++) if (has[k]) return k;
  return has.length;
}
