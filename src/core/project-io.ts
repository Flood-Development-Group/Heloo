import { newId } from './ids';
import {
  DEFAULT_VOICE_PARAMS,
  MAX_PITCH,
  MIN_NOTE_TICKS,
  MIN_PITCH,
  PARAM_INFO,
  PARAM_NAMES,
  TRACK_COLORS,
  emptyParams,
  type CurvePoint,
  type Language,
  type Note,
  type Project,
  type Track,
  type VoiceParams,
} from './model';
import { simplify } from './curves';
import { PPQ, clampBpm, type TempoMarker } from './time';

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p);
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, fallback: string, maxLen = 200): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function parseNote(v: unknown): Note | null {
  if (!isObj(v)) return null;
  const onset = Math.round(num(v.onset, NaN, 0));
  const duration = Math.round(num(v.duration, NaN, MIN_NOTE_TICKS));
  const pitch = Math.round(num(v.pitch, NaN, MIN_PITCH, MAX_PITCH));
  if (!Number.isFinite(onset) || !Number.isFinite(duration) || !Number.isFinite(pitch)) return null;
  const note: Note = {
    id: str(v.id, '', 64) || newId('n'),
    onset,
    duration,
    pitch,
    lyric: str(v.lyric, 'la', 64),
  };
  if (typeof v.phonemes === 'string' && v.phonemes.trim() !== '') note.phonemes = v.phonemes.slice(0, 200);
  const optional: [keyof Note, number, number][] = [
    ['vibratoDepth', 0, 3],
    ['vibratoRate', 0.5, 15],
    ['vibratoDelay', 0, 10],
    ['portamento', 0.005, 1],
  ];
  for (const [key, min, max] of optional) {
    const raw = v[key];
    if (raw !== undefined && raw !== null) {
      const n = num(raw, NaN, min, max);
      if (Number.isFinite(n)) (note as unknown as Record<string, number>)[key] = n;
    }
  }
  return note;
}

function parseCurve(v: unknown, min: number, max: number, def: number): CurvePoint[] {
  if (!Array.isArray(v)) return [];
  const pts: CurvePoint[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const t = num(p[0], NaN);
    const val = num(p[1], NaN, min, max);
    if (Number.isFinite(t) && Number.isFinite(val)) pts.push([Math.round(t), val]);
  }
  return simplify(pts, def);
}

function parseVoiceParams(v: unknown): VoiceParams {
  const o = isObj(v) ? v : {};
  const d = DEFAULT_VOICE_PARAMS;
  return {
    vibratoDepth: num(o.vibratoDepth, d.vibratoDepth, 0, 3),
    vibratoRate: num(o.vibratoRate, d.vibratoRate, 0.5, 15),
    vibratoDelay: num(o.vibratoDelay, d.vibratoDelay, 0, 10),
    portamento: num(o.portamento, d.portamento, 0.005, 1),
    gender: num(o.gender, d.gender, -1, 1),
    breathiness: num(o.breathiness, d.breathiness, -1, 1),
    tension: num(o.tension, d.tension, -1, 1),
  };
}

function parseTrack(v: unknown, index: number): Track {
  const o = isObj(v) ? v : {};
  const notes = Array.isArray(o.notes) ? o.notes.map(parseNote).filter((n): n is Note => n !== null) : [];
  // Ensure unique note ids.
  const seen = new Set<string>();
  for (const n of notes) {
    if (seen.has(n.id)) n.id = newId('n');
    seen.add(n.id);
  }
  const params = emptyParams();
  const rawParams = isObj(o.params) ? o.params : {};
  for (const name of PARAM_NAMES) {
    const info = PARAM_INFO[name];
    params[name] = parseCurve(rawParams[name], info.min, info.max, info.default);
  }
  const language: Language = o.language === 'ja' ? 'ja' : 'en';
  return {
    id: str(o.id, '', 64) || newId('t'),
    name: str(o.name, `Track ${index + 1}`, 60),
    color: typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : TRACK_COLORS[index % TRACK_COLORS.length],
    voice: str(o.voice, 'builtin:aria', 120),
    language,
    muted: bool(o.muted, false),
    solo: bool(o.solo, false),
    gainDb: num(o.gainDb, 0, -60, 12),
    pan: num(o.pan, 0, -1, 1),
    notes,
    params,
    voiceParams: parseVoiceParams(o.voiceParams),
  };
}

/** Parses and validates a project file. Unknown fields are dropped and values are clamped. */
export function parseProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('This file is not valid JSON.');
  }
  if (!isObj(raw) || raw.format !== 'heloo-project') {
    throw new ProjectFormatError('This is not a Heloo project file.');
  }
  const version = num(raw.version, NaN);
  if (version !== 1) {
    throw new ProjectFormatError(`Unsupported project version: ${String(raw.version)}.`);
  }
  const srcPpq = num(raw.ppq, PPQ, 24, 15360);
  const scale = PPQ / srcPpq;

  const tempos: TempoMarker[] = (Array.isArray(raw.tempos) ? raw.tempos : [])
    .filter(isObj)
    .map((m) => ({ tick: Math.max(0, Math.round(num(m.tick, 0) * scale)), bpm: clampBpm(num(m.bpm, 120)) }))
    .sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0 || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0]?.bpm ?? 120 });

  const tsRaw = isObj(raw.timeSignature) ? raw.timeSignature : {};
  const den = num(tsRaw.denominator, 4);
  const timeSignature = {
    numerator: Math.round(num(tsRaw.numerator, 4, 1, 32)),
    denominator: [1, 2, 4, 8, 16, 32].includes(den) ? den : 4,
  };

  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).slice(0, 64).map(parseTrack);
  if (scale !== 1) {
    for (const t of tracks) {
      for (const n of t.notes) {
        n.onset = Math.round(n.onset * scale);
        n.duration = Math.max(MIN_NOTE_TICKS, Math.round(n.duration * scale));
      }
      for (const name of PARAM_NAMES) t.params[name] = t.params[name].map(([tk, v]) => [Math.round(tk * scale), v]);
    }
  }
  const trackIds = new Set<string>();
  for (const t of tracks) {
    if (trackIds.has(t.id)) t.id = newId('t');
    trackIds.add(t.id);
  }
  return {
    format: 'heloo-project',
    version: 1,
    name: str(raw.name, 'Untitled', 120),
    ppq: PPQ,
    tempos,
    timeSignature,
    tracks,
  };
}
