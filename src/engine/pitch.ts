import { sampleCurveSorted } from '../core/curves';
import type { CurvePoint } from '../core/model';
import type { TempoMap } from '../core/time';
import { isConnected, type TimedNote } from './notes';

export interface PitchCurves {
  pitchBend: readonly CurvePoint[];
  vibratoEnv: readonly CurvePoint[];
}

const ATTACK_TIME = 0.1;
const ATTACK_DEPTH = 0.35; // semitones below the target at the start of a note after silence
const RELEASE_TIME = 0.08;
const RELEASE_DEPTH = 0.4;
const OVERSHOOT_TIME = 0.15;
const OVERSHOOT_RATIO = 0.07;
const PREP_TIME = 0.08;
const PREP_RATIO = 0.04;
const VIBRATO_FADE_IN = 0.25;

function smoothstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

interface Transition {
  /** Index of the note being entered. */
  to: number;
  ts: number;
  te: number;
  delta: number;
}

/**
 * Generates the sung pitch (in MIDI semitones) from notes: legato transitions with slight
 * preparation and overshoot, attack scoops after silence, release falls, vibrato, the
 * pitch-bend curve, and a small deterministic drift. It only depends on neighbouring notes,
 * so rendering phrase by phrase matches the full-track curve.
 */
export class PitchModel {
  private readonly transitions: (Transition | null)[];

  constructor(
    private readonly notes: readonly TimedNote[],
    private readonly curves: PitchCurves,
    private readonly tempo: TempoMap,
  ) {
    this.transitions = notes.map((n, i) => {
      const prev = notes[i - 1];
      if (!prev || !isConnected(prev, n)) return null;
      const T = clamp(n.portamento, 0.005, 0.5);
      const ts = Math.max(prev.start + 0.3 * (prev.end - prev.start), n.start - 0.6 * T);
      // Ends before the earliest point the next transition may start (30% into this note).
      const te = Math.min(n.start + 0.3 * (n.end - n.start), n.start + 0.4 * T);
      return { to: i, ts, te: Math.max(te, ts + 1e-4), delta: n.pitch - prev.pitch };
    });
  }

  /** Index of the last note starting at or before t (or 0). */
  private noteIndex(t: number): number {
    const ns = this.notes;
    let lo = 0;
    let hi = ns.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ns[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Pitch without the user curves (used for both display and synthesis). */
  basePitch(t: number, i = this.noteIndex(t)): number {
    const ns = this.notes;
    if (ns.length === 0) return 60;
    const n = ns[i];
    let p = n.pitch;
    const into = this.transitions[i];
    const next = this.transitions[i + 1];
    if (next && t >= next.ts) {
      const u = (t - next.ts) / (next.te - next.ts);
      p = ns[i].pitch + next.delta * smoothstep(u);
    } else if (into && t < into.te) {
      const u = (t - into.ts) / (into.te - into.ts);
      p = ns[i - 1].pitch + into.delta * smoothstep(u);
    }
    // Expressive details.
    if (into) {
      const d = clamp(into.delta, -7, 7);
      const u = (t - into.te) / OVERSHOOT_TIME;
      if (u >= 0 && u < 1) p += d * OVERSHOOT_RATIO * Math.sin(Math.PI * u) * (1 - u);
    } else if (t < n.start + ATTACK_TIME) {
      const u = clamp((t - n.start) / ATTACK_TIME, 0, 1);
      p -= ATTACK_DEPTH * (1 - u) * (1 - u);
    }
    if (next) {
      const d = clamp(next.delta, -7, 7);
      const u = (t - (next.ts - PREP_TIME)) / PREP_TIME;
      if (u >= 0 && u < 1) p -= d * PREP_RATIO * Math.sin(Math.PI * u);
    } else if (t > n.end - RELEASE_TIME) {
      const u = clamp((t - (n.end - RELEASE_TIME)) / RELEASE_TIME, 0, 1);
      p -= RELEASE_DEPTH * u * u;
    }
    return p;
  }

  /** Vibrato deviation in semitones before the envelope curve is applied. */
  vibrato(t: number, i = this.noteIndex(t)): number {
    const n = this.notes[i];
    if (!n || n.vibratoDepth <= 0) return 0;
    const tv = t - n.start - n.vibratoDelay;
    if (tv <= 0 || t >= n.end) return 0;
    const next = this.transitions[i + 1];
    const fadeOut = next ? clamp((next.ts - t) / 0.1, 0, 1) : clamp((n.end - t) / 0.12, 0, 1);
    const env = smoothstep(tv / VIBRATO_FADE_IN) * fadeOut;
    // Slight rate wobble keeps long vibratos from sounding mechanical.
    const phase = 2 * Math.PI * n.vibratoRate * tv + 0.35 * Math.sin(2 * Math.PI * 0.37 * tv);
    return n.vibratoDepth * env * Math.sin(phase);
  }

  /** Slow deterministic drift (semitones), a function of absolute time only. */
  static drift(t: number): number {
    return 0.035 * Math.sin(2 * Math.PI * 0.71 * t + 1.3) + 0.025 * Math.sin(2 * Math.PI * 1.37 * t + 4.1) + 0.012 * Math.sin(2 * Math.PI * 3.1 * t + 2.2);
  }

  /** Fills `out` with MIDI pitch for times t0 + k*dt. */
  fill(t0: number, dt: number, out: Float64Array): void {
    const n = out.length;
    const ticks = new Float64Array(n);
    for (let k = 0; k < n; k++) ticks[k] = this.tempo.secToTick(t0 + k * dt);
    const bend = new Float64Array(n);
    const vibEnv = new Float64Array(n);
    sampleCurveSorted(this.curves.pitchBend, ticks, 0, bend);
    sampleCurveSorted(this.curves.vibratoEnv, ticks, 1, vibEnv);
    for (let k = 0; k < n; k++) {
      const t = t0 + k * dt;
      const i = this.noteIndex(t);
      out[k] = this.basePitch(t, i) + this.vibrato(t, i) * vibEnv[k] + bend[k] / 100 + PitchModel.drift(t);
    }
  }

  midiAt(t: number): number {
    const out = new Float64Array(1);
    this.fill(t, 0, out);
    return out[0];
  }
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
