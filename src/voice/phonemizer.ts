import type { Language } from '../core/model';
import { englishDictionaryReady, englishToPhonemes, loadEnglishDictionary } from './english';
import { japaneseToPhonemes } from './japanese';
import { PHONEMES, isSonorant, isVowel } from './phonemes';

export type LyricResult =
  | { kind: 'phonemes'; phonemes: string[] }
  /** "-": hold the previous vowel (melisma). */
  | { kind: 'sustain' }
  /** "+": next syllable of the previous word. */
  | { kind: 'continue' }
  /** "br": a breath. */
  | { kind: 'breath' };

export function languageReady(lang: Language): boolean {
  return lang === 'en' ? englishDictionaryReady() : true;
}

export async function ensureLanguage(lang: Language): Promise<void> {
  if (lang === 'en') await loadEnglishDictionary();
}

/** Resolves a user-typed phoneme symbol to the inventory, ignoring case where unambiguous. */
export function resolveSymbol(sym: string, lang: Language): string | null {
  const s = sym.trim();
  if (!s) return null;
  if (PHONEMES.has(s)) return s;
  const lower = s.toLowerCase();
  const upper = s.toUpperCase();
  if (lang === 'ja') {
    if (PHONEMES.has(lower) && /^[aiueo]$|^cl$|^br$/.test(lower)) return lower;
    if (lower === 'n' || lower === 'nn' || lower === 'n\'') return 'NN';
    if (lower === 'r') return 'DX';
  }
  if (lower === 'br') return 'br';
  if (lower === 'cl') return 'cl';
  if (PHONEMES.has(upper)) return upper;
  if (PHONEMES.has(lower)) return lower;
  return null;
}

export function parsePhonemeString(text: string, lang: Language): string[] {
  return text
    .split(/[\s,]+/)
    .map((p) => resolveSymbol(p, lang))
    .filter((p): p is string => p !== null);
}

/** Converts a note lyric to phonemes. Works before dictionaries load (using rules). */
export function phonemizeLyric(lyric: string, lang: Language, override?: string): LyricResult {
  if (override && override.trim()) {
    const phs = parsePhonemeString(override, lang);
    if (phs.length > 0) return { kind: 'phonemes', phonemes: phs };
  }
  const text = lyric.trim();
  if (text === '' || text === '-' || text === 'ー' || text === '~') return { kind: 'sustain' };
  if (text === '+' || text === '+~') return { kind: 'continue' };
  if (text.toLowerCase() === 'br') return { kind: 'breath' };
  if (text.startsWith('.')) {
    const phs = parsePhonemeString(text.slice(1), lang);
    if (phs.length > 0) return { kind: 'phonemes', phonemes: phs };
    return { kind: 'sustain' };
  }
  if (lang === 'ja') {
    const ja = japaneseToPhonemes(text);
    if (ja) return ja;
    // Fall back to English rules for latin text that is not romaji.
  }
  const phs = englishToPhonemes(text);
  if (phs.length > 0) return { kind: 'phonemes', phonemes: phs };
  return { kind: 'phonemes', phonemes: [lang === 'ja' ? 'a' : 'AA'] };
}

export interface Syllable {
  onset: string[];
  nucleus: string;
  coda: string[];
}

/**
 * Splits a phoneme sequence into syllables around vowel nuclei.
 * Between two nuclei a single consonant goes to the next syllable; with more, the first
 * consonant closes the previous syllable and the rest start the next one.
 */
export function syllabify(
  phs: readonly string[],
  vowel: (p: string) => boolean = isVowel,
  sonorant: (p: string) => boolean = isSonorant,
): Syllable[] {
  if (phs.length === 0) return [];
  let nuclei: number[] = [];
  phs.forEach((p, i) => {
    if (vowel(p)) nuclei.push(i);
  });
  if (nuclei.length === 0) {
    // No vowel: use the last sonorant, else the last phoneme, as the sustained nucleus.
    let idx = -1;
    for (let i = phs.length - 1; i >= 0; i--) {
      if (sonorant(phs[i]) || phs[i] === 'NN') {
        idx = i;
        break;
      }
    }
    nuclei = [idx >= 0 ? idx : phs.length - 1];
  }
  const sylls: Syllable[] = [];
  let start = 0;
  for (let k = 0; k < nuclei.length; k++) {
    const n = nuclei[k];
    const nextN = nuclei[k + 1];
    let end: number; // exclusive end of this syllable
    if (nextN === undefined) end = phs.length;
    else {
      const between = nextN - n - 1;
      end = between <= 1 ? n + 1 : n + 2;
    }
    sylls.push({ onset: phs.slice(start, n), nucleus: phs[n], coda: phs.slice(n + 1, end) });
    start = end;
  }
  return sylls;
}
