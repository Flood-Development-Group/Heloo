/**
 * English lyric to ARPAbet using the CMU Pronouncing Dictionary (loaded lazily, ~4.7 MB)
 * with a rule-based fallback for words that are not in the dictionary.
 */

let dict: Record<string, string> | null = null;
let loading: Promise<void> | null = null;

export function englishDictionaryReady(): boolean {
  return dict !== null;
}

export function loadEnglishDictionary(): Promise<void> {
  if (dict) return Promise.resolve();
  if (!loading) {
    loading = import('cmu-pronouncing-dictionary')
      .then((m) => {
        dict = m.dictionary;
      })
      .catch((err: unknown) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/** For tests or custom dictionaries. */
export function setEnglishDictionary(d: Record<string, string>): void {
  dict = d;
}

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z']/g, '')
    .replace(/^'+|'+$/g, '');
}

/** User-defined words take priority over the dictionary. */
const userWords = new Map<string, string[]>();

export function setUserWord(word: string, phonemes: string[]): void {
  userWords.set(normalizeWord(word), phonemes);
}

export function lookupEnglish(word: string): string[] | null {
  const w = normalizeWord(word);
  if (!w) return null;
  const user = userWords.get(w);
  if (user) return user;
  const entry = dict?.[w];
  if (!entry) return null;
  return entry
    .split(' ')
    .filter(Boolean)
    .map((p) => p.replace(/[0-9]/g, ''));
}

const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

interface Rule {
  pat: string;
  out: string[];
  /** Only at the start of the word. */
  start?: boolean;
  /** Only at the end of the word. */
  end?: boolean;
}

// Ordered longest-first within each starting letter group.
const RULES: Rule[] = [
  { pat: 'tion', out: ['SH', 'AH', 'N'] },
  { pat: 'sion', out: ['ZH', 'AH', 'N'] },
  { pat: 'ough', out: ['AO'] },
  { pat: 'augh', out: ['AO'] },
  { pat: 'eigh', out: ['EY'] },
  { pat: 'igh', out: ['AY'] },
  { pat: 'tch', out: ['CH'] },
  { pat: 'sch', out: ['S', 'K'] },
  { pat: 'dge', out: ['JH'] },
  { pat: 'kn', out: ['N'], start: true },
  { pat: 'wr', out: ['R'], start: true },
  { pat: 'ps', out: ['S'], start: true },
  { pat: 'th', out: ['TH'] },
  { pat: 'sh', out: ['SH'] },
  { pat: 'ch', out: ['CH'] },
  { pat: 'ph', out: ['F'] },
  { pat: 'wh', out: ['W'] },
  { pat: 'ng', out: ['NG'] },
  { pat: 'ck', out: ['K'] },
  { pat: 'qu', out: ['K', 'W'] },
  { pat: 'gh', out: [] },
  { pat: 'ee', out: ['IY'] },
  { pat: 'ea', out: ['IY'] },
  { pat: 'oo', out: ['UW'] },
  { pat: 'ou', out: ['AW'] },
  { pat: 'ow', out: ['OW'], end: true },
  { pat: 'ow', out: ['AW'] },
  { pat: 'ai', out: ['EY'] },
  { pat: 'ay', out: ['EY'] },
  { pat: 'ey', out: ['EY'], end: true },
  { pat: 'oi', out: ['OY'] },
  { pat: 'oy', out: ['OY'] },
  { pat: 'au', out: ['AO'] },
  { pat: 'aw', out: ['AO'] },
  { pat: 'ie', out: ['IY'] },
  { pat: 'ue', out: ['UW'] },
  { pat: 'ew', out: ['UW'] },
  { pat: 'oa', out: ['OW'] },
  { pat: 'ar', out: ['AA', 'R'] },
  { pat: 'or', out: ['AO', 'R'] },
  { pat: 'er', out: ['ER'] },
  { pat: 'ir', out: ['ER'] },
  { pat: 'ur', out: ['ER'] },
  { pat: 'le', out: ['AH', 'L'], end: true },
  { pat: 'x', out: ['K', 'S'] },
  { pat: 'j', out: ['JH'] },
  { pat: 'q', out: ['K'] },
  { pat: 'z', out: ['Z'] },
  { pat: 'v', out: ['V'] },
  { pat: 'w', out: ['W'] },
  { pat: 'b', out: ['B'] },
  { pat: 'd', out: ['D'] },
  { pat: 'f', out: ['F'] },
  { pat: 'h', out: ['HH'] },
  { pat: 'k', out: ['K'] },
  { pat: 'l', out: ['L'] },
  { pat: 'm', out: ['M'] },
  { pat: 'n', out: ['N'] },
  { pat: 'p', out: ['P'] },
  { pat: 'r', out: ['R'] },
  { pat: 's', out: ['S'] },
  { pat: 't', out: ['T'] },
];

const SHORT: Record<string, string> = { a: 'AE', e: 'EH', i: 'IH', o: 'AA', u: 'AH', y: 'IH' };
const LONG: Record<string, string> = { a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW', y: 'AY' };

/** Rough letter-to-sound rules for words missing from the dictionary. */
export function englishLetterToSound(word: string): string[] {
  let w = normalizeWord(word).replace(/'/g, '');
  if (!w) return [];
  // Collapse doubled consonants.
  w = w.replace(/([b-df-hj-np-tv-z])\1/g, '$1');
  const out: string[] = [];
  const n = w.length;
  // Magic e: V C e at the end makes the vowel long and the e silent.
  const magicE = n >= 3 && w[n - 1] === 'e' && !VOWEL_LETTERS.has(w[n - 2]) && VOWEL_LETTERS.has(w[n - 3]) && w[n - 3] !== 'y';
  const magicIndex = magicE ? n - 3 : -1;
  let i = 0;
  while (i < n) {
    const ch = w[i];
    if (magicE && i === n - 1) break;
    if (ch === 'e' && i === n - 1 && out.some((p) => /^[AEIOU]/.test(p))) break; // silent final e
    let matched = false;
    if (i !== magicIndex) {
      for (const r of RULES) {
        if (r.start && i !== 0) continue;
        if (r.end && i + r.pat.length !== n) continue;
        if (w.startsWith(r.pat, i)) {
          out.push(...r.out);
          i += r.pat.length;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;
    if (ch === 'c') {
      out.push('eiy'.includes(w[i + 1] ?? '') ? 'S' : 'K');
    } else if (ch === 'g') {
      out.push('eiy'.includes(w[i + 1] ?? '') && i + 1 < n - 1 ? 'JH' : 'G');
    } else if (ch === 'y') {
      if (i === 0 && VOWEL_LETTERS.has(w[1] ?? '')) out.push('Y');
      else out.push(i === n - 1 ? (n <= 3 ? 'AY' : 'IY') : 'IH');
    } else if (VOWEL_LETTERS.has(ch)) {
      if (i === magicIndex) out.push(LONG[ch]);
      else if (i === n - 1 && ch !== 'e') out.push(ch === 'o' ? 'OW' : ch === 'a' ? 'AA' : ch === 'u' ? 'UW' : 'IY');
      else out.push(SHORT[ch]);
    }
    i++;
  }
  return out;
}

export function englishToPhonemes(lyric: string): string[] {
  const words = lyric.split(/[\s\-_]+/).filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    out.push(...(lookupEnglish(word) ?? englishLetterToSound(word)));
  }
  return out;
}
