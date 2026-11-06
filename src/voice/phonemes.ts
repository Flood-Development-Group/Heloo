/**
 * Phoneme inventory shared by the phonemizer and the built-in synthesizer.
 * English uses ARPAbet symbols (upper case); Japanese uses lower-case symbols.
 * Formant values are adult male averages (Hz); voices scale them.
 */

export type PhClass =
  | 'vowel'
  | 'diphthong'
  | 'nasal'
  | 'liquid'
  | 'glide'
  | 'stop'
  | 'fricative'
  | 'affricate'
  | 'aspirate'
  | 'flap'
  | 'closure';

/** Frication spectrum shapes, as gains for the synthesizer's fixed band bank. */
export type FricShape = 's' | 'sh' | 'f' | 'th' | 'burstLabial' | 'burstAlveolar' | 'burstVelar' | 'h';

export interface PhonemeDef {
  sym: string;
  cls: PhClass;
  voiced: boolean;
  /** F1..F5 targets. */
  f: [number, number, number, number, number];
  /** Bandwidths for F1..F5. */
  b: [number, number, number, number, number];
  /** End target for diphthongs. */
  f2?: [number, number, number, number, number];
  /** Nasal anti-formant [freq, bandwidth]. */
  zero?: [number, number];
  fric?: FricShape;
  /** Burst shape for stops/affricates. */
  burst?: FricShape;
  /** Default duration in seconds (consonants). */
  dur: number;
  /** Relative voicing level for voiced consonants. */
  level: number;
}

const VB: [number, number, number, number, number] = [60, 90, 120, 160, 200];
const CB: [number, number, number, number, number] = [80, 120, 160, 250, 300];
const NB: [number, number, number, number, number] = [60, 300, 300, 400, 500];

function vowel(sym: string, f1: number, f2: number, f3: number, end?: [number, number, number]): PhonemeDef {
  return {
    sym,
    cls: end ? 'diphthong' : 'vowel',
    voiced: true,
    f: [f1, f2, f3, 3500, 4500],
    b: VB,
    ...(end ? { f2: [end[0], end[1], end[2], 3500, 4500] as [number, number, number, number, number] } : {}),
    dur: 0.2,
    level: 1,
  };
}

function cons(
  sym: string,
  cls: PhClass,
  voiced: boolean,
  f: [number, number, number],
  dur: number,
  extra: Partial<PhonemeDef> = {},
): PhonemeDef {
  return {
    sym,
    cls,
    voiced,
    f: [f[0], f[1], f[2], 3300, 4300],
    b: cls === 'nasal' ? NB : CB,
    dur,
    level: voiced ? 0.6 : 0,
    ...extra,
  };
}

const LABIAL: [number, number, number] = [250, 900, 2100];
const ALVEOLAR: [number, number, number] = [250, 1700, 2600];
const VELAR: [number, number, number] = [250, 1900, 2300];
const POSTALV: [number, number, number] = [280, 1900, 2500];
const DENTAL: [number, number, number] = [280, 1400, 2600];

const DEFS: PhonemeDef[] = [
  // English vowels (ARPAbet)
  vowel('IY', 270, 2290, 3010),
  vowel('IH', 390, 1990, 2550),
  vowel('EH', 530, 1840, 2480),
  vowel('AE', 660, 1720, 2410),
  vowel('AA', 730, 1090, 2440),
  vowel('AO', 570, 840, 2410),
  vowel('UH', 440, 1020, 2240),
  vowel('UW', 300, 870, 2240),
  vowel('AH', 640, 1190, 2390),
  vowel('AX', 500, 1400, 2400),
  vowel('ER', 490, 1350, 1690),
  vowel('EY', 480, 1900, 2500, [330, 2200, 2900]),
  vowel('AY', 700, 1200, 2500, [380, 2000, 2600]),
  vowel('OY', 550, 900, 2400, [380, 1950, 2600]),
  vowel('AW', 700, 1200, 2450, [420, 950, 2300]),
  vowel('OW', 520, 950, 2400, [350, 800, 2300]),
  // English consonants
  cons('P', 'stop', false, LABIAL, 0.075, { burst: 'burstLabial' }),
  cons('B', 'stop', true, LABIAL, 0.065, { burst: 'burstLabial', level: 0.12 }),
  cons('T', 'stop', false, ALVEOLAR, 0.075, { burst: 'burstAlveolar' }),
  cons('D', 'stop', true, ALVEOLAR, 0.06, { burst: 'burstAlveolar', level: 0.12 }),
  cons('K', 'stop', false, VELAR, 0.08, { burst: 'burstVelar' }),
  cons('G', 'stop', true, VELAR, 0.065, { burst: 'burstVelar', level: 0.12 }),
  cons('F', 'fricative', false, LABIAL, 0.095, { fric: 'f' }),
  cons('V', 'fricative', true, LABIAL, 0.07, { fric: 'f', level: 0.45 }),
  cons('TH', 'fricative', false, DENTAL, 0.09, { fric: 'th' }),
  cons('DH', 'fricative', true, DENTAL, 0.05, { fric: 'th', level: 0.5 }),
  cons('S', 'fricative', false, ALVEOLAR, 0.11, { fric: 's' }),
  cons('Z', 'fricative', true, ALVEOLAR, 0.085, { fric: 's', level: 0.45 }),
  cons('SH', 'fricative', false, POSTALV, 0.11, { fric: 'sh' }),
  cons('ZH', 'fricative', true, POSTALV, 0.085, { fric: 'sh', level: 0.45 }),
  cons('HH', 'aspirate', false, [500, 1500, 2500], 0.07, { fric: 'h' }),
  cons('CH', 'affricate', false, POSTALV, 0.11, { fric: 'sh', burst: 'burstAlveolar' }),
  cons('JH', 'affricate', true, POSTALV, 0.09, { fric: 'sh', burst: 'burstAlveolar', level: 0.4 }),
  cons('TS', 'affricate', false, ALVEOLAR, 0.1, { fric: 's', burst: 'burstAlveolar' }),
  cons('M', 'nasal', true, [280, 1100, 2200], 0.075, { zero: [750, 100], level: 0.55 }),
  cons('N', 'nasal', true, [280, 1500, 2600], 0.07, { zero: [1450, 150], level: 0.55 }),
  cons('NG', 'nasal', true, [280, 2000, 2700], 0.075, { zero: [3000, 250], level: 0.5 }),
  cons('L', 'liquid', true, [360, 1100, 2700], 0.065, { level: 0.75, b: [60, 120, 150, 250, 300] }),
  cons('R', 'liquid', true, [420, 1300, 1600], 0.065, { level: 0.8, b: [70, 100, 120, 250, 300] }),
  cons('W', 'glide', true, [290, 610, 2150], 0.055, { level: 0.7, b: [50, 80, 100, 250, 300] }),
  cons('Y', 'glide', true, [260, 2070, 3020], 0.05, { level: 0.75, b: [40, 250, 300, 300, 300] }),
  cons('DX', 'flap', true, ALVEOLAR, 0.03, { level: 0.5 }),
  // Japanese vowels
  vowel('a', 750, 1250, 2600),
  vowel('i', 300, 2250, 3000),
  vowel('u', 350, 1350, 2400),
  vowel('e', 480, 1900, 2550),
  vowel('o', 500, 850, 2500),
  // Japanese special morae
  cons('NN', 'nasal', true, [280, 1200, 2500], 0.15, { zero: [1200, 200], level: 0.6 }),
  cons('cl', 'closure', false, [400, 1500, 2500], 0.07),
  // Breath
  cons('br', 'aspirate', false, [600, 1400, 2500], 0.35, { fric: 'h' }),
];

export const PHONEMES: ReadonlyMap<string, PhonemeDef> = new Map(DEFS.map((d) => [d.sym, d]));

export function phonemeDef(sym: string): PhonemeDef | undefined {
  return PHONEMES.get(sym);
}

export function isVowel(sym: string): boolean {
  const c = PHONEMES.get(sym)?.cls;
  return c === 'vowel' || c === 'diphthong';
}

/** Phonemes that can carry a sustained note when no vowel is present. */
export function isSonorant(sym: string): boolean {
  const c = PHONEMES.get(sym)?.cls;
  return c === 'vowel' || c === 'diphthong' || c === 'nasal' || c === 'liquid' || c === 'glide';
}

/** Japanese consonant symbols map onto the shared consonant definitions. */
export const JA_CONSONANT_MAP: Readonly<Record<string, string[]>> = {
  k: ['K'],
  g: ['G'],
  s: ['S'],
  sh: ['SH'],
  z: ['Z'],
  j: ['JH'],
  t: ['T'],
  ch: ['CH'],
  ts: ['TS'],
  d: ['D'],
  n: ['N'],
  h: ['HH'],
  f: ['F'],
  b: ['B'],
  p: ['P'],
  m: ['M'],
  y: ['Y'],
  r: ['DX'],
  w: ['W'],
  v: ['V'],
  ky: ['K', 'Y'],
  gy: ['G', 'Y'],
  ny: ['N', 'Y'],
  hy: ['HH', 'Y'],
  by: ['B', 'Y'],
  py: ['P', 'Y'],
  my: ['M', 'Y'],
  ry: ['DX', 'Y'],
};
