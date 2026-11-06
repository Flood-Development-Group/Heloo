import { PARAM_NAMES, type CurvePoint, type Language, type ParamName, type Project, type Track, type VoiceParams } from '../core/model';
import { TempoMap, type TempoMarker } from '../core/time';
import { hashString } from './hash';
import { PHRASE_PREROLL, PHRASE_TAIL, splitPhrases, timedNotes, type TimedNote } from './notes';
import { layoutPhrase, type PhSeg } from './timing';

/** Bump when the synthesis output changes so cached audio is not reused. */
export const ENGINE_VERSION = 1;
export const SAMPLE_RATE = 44100;

/** Everything a worker needs to render one phrase, with no access to the project. */
export interface RenderJob {
  key: string;
  trackId: string;
  voice: string;
  language: Language;
  /** Audio start/end in seconds. */
  start: number;
  end: number;
  notes: TimedNote[];
  segs: PhSeg[];
  voiceParams: VoiceParams;
  curves: Record<ParamName, CurvePoint[]>;
  tempos: TempoMarker[];
  sampleRate: number;
}

export interface TrackPlan {
  trackId: string;
  jobs: RenderJob[];
  /** Phonemes shown under each note, by note id. */
  phonemes: Map<string, string[]>;
}

/**
 * The points of a curve that determine its values within [t0, t1]: the points inside, plus the
 * neighbour on each side when the curve is interpolated across that boundary.
 */
export function sliceCurve(points: readonly CurvePoint[], t0: number, t1: number): CurvePoint[] {
  let a = 0;
  while (a < points.length && points[a][0] < t0) a++;
  let b = points.length - 1;
  while (b >= 0 && points[b][0] > t1) b--;
  // points[a..b] are inside; a-1 is the neighbour before, b+1 the neighbour after.
  const hasInside = b >= a;
  const hasBefore = a - 1 >= 0;
  const hasAfter = b + 1 < points.length;
  const from = hasBefore && (hasInside || hasAfter) ? a - 1 : a;
  const to = hasAfter && (hasInside || hasBefore) ? b + 1 : b;
  if (to < from) return [];
  return points.slice(from, to + 1).map((p) => [p[0], p[1]] as CurvePoint);
}

export function planTrack(track: Track, tempo: TempoMap, sampleRate = SAMPLE_RATE): TrackPlan {
  const notes = timedNotes(track, tempo);
  const phrases = splitPhrases(notes);
  const phonemes = new Map<string, string[]>();
  const jobs: RenderJob[] = [];
  for (const phrase of phrases) {
    const layout = layoutPhrase(phrase, track.language);
    phrase.forEach((n, i) => phonemes.set(n.id, layout.display[i]));
    const start = phrase[0].start - PHRASE_PREROLL;
    const end = phrase[phrase.length - 1].end + PHRASE_TAIL;
    const tickStart = tempo.secToTick(start);
    const tickEnd = tempo.secToTick(end);
    const curves = {} as Record<ParamName, CurvePoint[]>;
    for (const name of PARAM_NAMES) curves[name] = sliceCurve(track.params[name], tickStart, tickEnd);
    const tempos = tempo.list.filter((m) => m.tick <= tickEnd);
    const content = {
      v: ENGINE_VERSION,
      voice: track.voice,
      language: track.language,
      start,
      end,
      notes: phrase,
      segs: layout.segs,
      voiceParams: track.voiceParams,
      curves,
      tempos,
      sampleRate,
    };
    const key = hashString(JSON.stringify(content));
    jobs.push({ key, trackId: track.id, ...content, notes: phrase, segs: layout.segs, voiceParams: { ...track.voiceParams } });
  }
  return { trackId: track.id, jobs, phonemes };
}

export function planProject(project: Project, sampleRate = SAMPLE_RATE): TrackPlan[] {
  const tempo = new TempoMap(project.tempos);
  return project.tracks.map((t) => planTrack(t, tempo, sampleRate));
}
