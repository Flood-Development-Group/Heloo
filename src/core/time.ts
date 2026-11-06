/** Ticks per quarter note used throughout the project. */
export const PPQ = 480;

export interface TempoMarker {
  tick: number;
  bpm: number;
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export const MIN_BPM = 20;
export const MAX_BPM = 400;

interface ResolvedMarker {
  tick: number;
  bpm: number;
  sec: number;
}

/**
 * Converts between ticks and seconds for a list of tempo markers.
 * Ticks before 0 (used for pre-roll) are extrapolated with the first tempo.
 */
export class TempoMap {
  private readonly markers: ResolvedMarker[];

  constructor(input: readonly TempoMarker[]) {
    const valid = input
      .filter((m) => Number.isFinite(m.tick) && Number.isFinite(m.bpm) && m.bpm > 0)
      .map((m) => ({ tick: Math.max(0, Math.round(m.tick)), bpm: clampBpm(m.bpm) }))
      .sort((a, b) => a.tick - b.tick);
    // Keep the last marker for duplicate ticks.
    const deduped: { tick: number; bpm: number }[] = [];
    for (const m of valid) {
      const last = deduped[deduped.length - 1];
      if (last && last.tick === m.tick) last.bpm = m.bpm;
      else deduped.push({ ...m });
    }
    if (deduped.length === 0) deduped.push({ tick: 0, bpm: 120 });
    if (deduped[0].tick !== 0) deduped.unshift({ tick: 0, bpm: deduped[0].bpm });

    const resolved: ResolvedMarker[] = [];
    let sec = 0;
    for (let i = 0; i < deduped.length; i++) {
      const m = deduped[i];
      if (i > 0) {
        const prev = deduped[i - 1];
        sec += ((m.tick - prev.tick) * 60) / (prev.bpm * PPQ);
      }
      resolved.push({ tick: m.tick, bpm: m.bpm, sec });
    }
    this.markers = resolved;
  }

  get list(): readonly TempoMarker[] {
    return this.markers.map((m) => ({ tick: m.tick, bpm: m.bpm }));
  }

  private indexForTick(tick: number): number {
    const ms = this.markers;
    let lo = 0;
    let hi = ms.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ms[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private indexForSec(sec: number): number {
    const ms = this.markers;
    let lo = 0;
    let hi = ms.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ms[mid].sec <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  tickToSec(tick: number): number {
    const m = this.markers[this.indexForTick(tick)];
    return m.sec + ((tick - m.tick) * 60) / (m.bpm * PPQ);
  }

  secToTick(sec: number): number {
    const m = this.markers[this.indexForSec(sec)];
    return m.tick + ((sec - m.sec) * m.bpm * PPQ) / 60;
  }

  bpmAt(tick: number): number {
    return this.markers[this.indexForTick(tick)].bpm;
  }
}

export function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

export function ticksPerBeat(ts: TimeSignature): number {
  return (PPQ * 4) / ts.denominator;
}

export function ticksPerBar(ts: TimeSignature): number {
  return ticksPerBeat(ts) * ts.numerator;
}

/** Formats a tick position as "bar.beat" (1-based). */
export function formatBarBeat(tick: number, ts: TimeSignature): string {
  const bar = Math.floor(tick / ticksPerBar(ts));
  const beat = Math.floor((tick - bar * ticksPerBar(ts)) / ticksPerBeat(ts));
  return `${bar + 1}.${beat + 1}`;
}

export function formatSeconds(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}
