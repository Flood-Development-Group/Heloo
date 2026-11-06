import { newId } from './ids';
import { PPQ, type TempoMarker, type TimeSignature } from './time';

export type Language = 'en' | 'ja';

export type ParamName = 'pitchBend' | 'loudness' | 'breathiness' | 'gender' | 'tension' | 'vibratoEnv';

export interface ParamInfo {
  label: string;
  short: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  /** Description shown in the UI. */
  hint: string;
}

export const PARAM_NAMES: readonly ParamName[] = [
  'pitchBend',
  'loudness',
  'breathiness',
  'gender',
  'tension',
  'vibratoEnv',
];

export const PARAM_INFO: Record<ParamName, ParamInfo> = {
  pitchBend: {
    label: 'Pitch Bend',
    short: 'Pitch',
    min: -600,
    max: 600,
    default: 0,
    unit: 'cents',
    hint: 'Offset added to the generated pitch curve.',
  },
  loudness: {
    label: 'Loudness',
    short: 'Loud',
    min: -24,
    max: 12,
    default: 0,
    unit: 'dB',
    hint: 'Volume change over time.',
  },
  breathiness: {
    label: 'Breathiness',
    short: 'Breath',
    min: -1,
    max: 1,
    default: 0,
    unit: '',
    hint: 'More air (+) or a cleaner tone (−).',
  },
  gender: {
    label: 'Gender',
    short: 'Gender',
    min: -1,
    max: 1,
    default: 0,
    unit: '',
    hint: 'Deeper, more masculine formants (+) or brighter, more feminine (−).',
  },
  tension: {
    label: 'Tension',
    short: 'Tension',
    min: -1,
    max: 1,
    default: 0,
    unit: '',
    hint: 'Pressed, bright tone (+) or soft, relaxed tone (−).',
  },
  vibratoEnv: {
    label: 'Vibrato Envelope',
    short: 'Vib Env',
    min: 0,
    max: 2,
    default: 1,
    unit: '×',
    hint: 'Scales the vibrato depth over time.',
  },
};

/** [tick, value] */
export type CurvePoint = [number, number];

export interface Note {
  id: string;
  /** Start position in ticks. */
  onset: number;
  /** Length in ticks. */
  duration: number;
  /** MIDI note number (60 = C4). */
  pitch: number;
  /** Lyric text. "-" sustains the previous vowel, "+" continues the previous word's next syllable, "br" is a breath. */
  lyric: string;
  /** Optional space-separated phoneme override. */
  phonemes?: string;
  /** Per-note overrides; undefined means use the track default. */
  vibratoDepth?: number;
  vibratoRate?: number;
  vibratoDelay?: number;
  portamento?: number;
}

export interface VoiceParams {
  /** Vibrato depth in semitones (peak deviation). */
  vibratoDepth: number;
  /** Vibrato rate in Hz. */
  vibratoRate: number;
  /** Delay from note start before vibrato begins, seconds. */
  vibratoDelay: number;
  /** Pitch transition time between connected notes, seconds. */
  portamento: number;
  /** Global offsets added to the parameter curves. */
  gender: number;
  breathiness: number;
  tension: number;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  /** Voice id, e.g. "builtin:aria" or "ds:<voicebank id>". */
  voice: string;
  language: Language;
  muted: boolean;
  solo: boolean;
  gainDb: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  notes: Note[];
  params: Record<ParamName, CurvePoint[]>;
  voiceParams: VoiceParams;
}

export interface Project {
  format: 'heloo-project';
  version: 1;
  name: string;
  ppq: typeof PPQ;
  tempos: TempoMarker[];
  timeSignature: TimeSignature;
  tracks: Track[];
}

export const TRACK_COLORS = ['#4fc3f7', '#f48fb1', '#aed581', '#ffb74d', '#ba68c8', '#4db6ac', '#e57373', '#90a4ae'];

export const DEFAULT_VOICE_PARAMS: VoiceParams = {
  vibratoDepth: 0.2,
  vibratoRate: 5.5,
  vibratoDelay: 0.3,
  portamento: 0.08,
  gender: 0,
  breathiness: 0,
  tension: 0,
};

export const MIN_PITCH = 24; // C1
export const MAX_PITCH = 108; // C8
export const MIN_NOTE_TICKS = 15; // 1/128 note

export function emptyParams(): Record<ParamName, CurvePoint[]> {
  return {
    pitchBend: [],
    loudness: [],
    breathiness: [],
    gender: [],
    tension: [],
    vibratoEnv: [],
  };
}

export function createTrack(index: number, partial: Partial<Track> = {}): Track {
  return {
    id: newId('t'),
    name: `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    voice: 'builtin:aria',
    language: 'en',
    muted: false,
    solo: false,
    gainDb: 0,
    pan: 0,
    notes: [],
    params: emptyParams(),
    voiceParams: { ...DEFAULT_VOICE_PARAMS },
    ...partial,
  };
}

export function createNote(onset: number, duration: number, pitch: number, lyric: string): Note {
  return { id: newId('n'), onset, duration, pitch, lyric };
}

export function createProject(name = 'Untitled'): Project {
  return {
    format: 'heloo-project',
    version: 1,
    name,
    ppq: PPQ,
    tempos: [{ tick: 0, bpm: 120 }],
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [createTrack(0)],
  };
}

/** A small demo song so the app makes sound on first launch. */
export function createDemoProject(): Project {
  const p = createProject('Demo');
  const t = p.tracks[0];
  t.name = 'Lead';
  const q = PPQ;
  // An original melody and lyric. "+" puts the next syllable of the previous word on a note,
  // "-" holds the previous vowel on a new pitch.
  const melody: [number, number, string][] = [
    [67, 1, 'morning'],
    [69, 1, '+'],
    [71, 2, 'light'],
    [69, 1, 'is'],
    [67, 1, 'calling'],
    [64, 2, '+'],
    [62, 1, 'sing'],
    [64, 1, 'along'],
    [67, 1, '+'],
    [69, 1, 'with'],
    [67, 1, 'me'],
    [69, 1, '-'],
    [64, 1, 'oh'],
    [67, 2, 'now'],
  ];
  let tick = 0;
  for (const [pitch, beats, lyric] of melody) {
    const connected = beats === 1;
    t.notes.push(createNote(tick, connected ? beats * q : beats * q - q / 4, pitch, lyric));
    tick += beats * q;
  }
  return p;
}

export function sortedNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function noteEnd(n: Note): number {
  return n.onset + n.duration;
}

export function projectEndTick(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const n of t.notes) end = Math.max(end, noteEnd(n));
  return end;
}

export function clampPitch(p: number): number {
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(p)));
}

export function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function pitchName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}
