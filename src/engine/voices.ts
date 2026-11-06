/** Built-in voices are parameter sets for the on-device formant synthesizer. */
export interface BuiltinVoice {
  id: string;
  name: string;
  description: string;
  /** Multiplies all formant frequencies (adult male = 1). */
  formantScale: number;
  /** Spectral tilt exponent: harmonic k has amplitude k^-tilt. */
  tilt: number;
  /** Base aspiration mixed into voiced sound (0..1). */
  breath: number;
  /** Output gain. */
  gain: number;
  /** Suggested comfortable range (MIDI), shown in the UI. */
  range: [number, number];
}

export const BUILTIN_VOICES: readonly BuiltinVoice[] = [
  {
    id: 'builtin:aria',
    name: 'Aria',
    description: 'Clear, light soprano/alto voice.',
    formantScale: 1.17,
    tilt: 1.08,
    breath: 0.22,
    gain: 1,
    range: [57, 81],
  },
  {
    id: 'builtin:leo',
    name: 'Leo',
    description: 'Warm tenor/baritone voice.',
    formantScale: 1.0,
    tilt: 0.98,
    breath: 0.12,
    gain: 1,
    range: [45, 69],
  },
  {
    id: 'builtin:kit',
    name: 'Kit',
    description: 'Bright, youthful voice.',
    formantScale: 1.28,
    tilt: 1.15,
    breath: 0.18,
    gain: 0.95,
    range: [60, 86],
  },
];

export function builtinVoice(id: string): BuiltinVoice {
  return BUILTIN_VOICES.find((v) => v.id === id) ?? BUILTIN_VOICES[0];
}

export function isBuiltinVoice(id: string): boolean {
  return id.startsWith('builtin:');
}
