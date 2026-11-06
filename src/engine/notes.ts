import type { Note, Track } from '../core/model';
import { sortedNotes } from '../core/model';
import type { TempoMap } from '../core/time';

/** A note resolved to seconds, with overlaps removed and per-note settings filled in. */
export interface TimedNote {
  id: string;
  start: number;
  end: number;
  pitch: number;
  lyric: string;
  phonemes?: string;
  vibratoDepth: number;
  vibratoRate: number;
  vibratoDelay: number;
  portamento: number;
}

/** Notes closer than this (seconds) are sung legato: pitch glides and phonemes connect. */
export const CONNECT_GAP = 0.06;
/** Notes separated by at least this much silence start a new phrase. */
export const PHRASE_GAP = 0.3;
/** Audio rendered before the first note of a phrase (room for leading consonants). */
export const PHRASE_PREROLL = 0.35;
/** Audio rendered after the last note of a phrase (release tail). */
export const PHRASE_TAIL = 0.3;

export function timedNotes(track: Track, tempo: TempoMap): TimedNote[] {
  const notes = sortedNotes(track.notes);
  const out: TimedNote[] = [];
  const vp = track.voiceParams;
  for (let i = 0; i < notes.length; i++) {
    const n: Note = notes[i];
    // Monophonic: a note ends where the next one starts.
    let endTick = n.onset + n.duration;
    const next = notes[i + 1];
    if (next && next.onset < endTick) endTick = next.onset;
    if (endTick <= n.onset) continue;
    const t: TimedNote = {
      id: n.id,
      start: tempo.tickToSec(n.onset),
      end: tempo.tickToSec(endTick),
      pitch: n.pitch,
      lyric: n.lyric,
      vibratoDepth: n.vibratoDepth ?? vp.vibratoDepth,
      vibratoRate: n.vibratoRate ?? vp.vibratoRate,
      vibratoDelay: n.vibratoDelay ?? vp.vibratoDelay,
      portamento: n.portamento ?? vp.portamento,
    };
    if (n.phonemes) t.phonemes = n.phonemes;
    out.push(t);
  }
  return out;
}

export function isConnected(a: TimedNote, b: TimedNote): boolean {
  return b.start - a.end < CONNECT_GAP;
}

export function splitPhrases(notes: readonly TimedNote[]): TimedNote[][] {
  const phrases: TimedNote[][] = [];
  let cur: TimedNote[] = [];
  for (const n of notes) {
    const last = cur[cur.length - 1];
    if (last && n.start - last.end >= PHRASE_GAP) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length > 0) phrases.push(cur);
  return phrases;
}
