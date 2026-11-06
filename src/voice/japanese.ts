import { JA_CONSONANT_MAP } from './phonemes';

/** Hiragana mora to Hepburn romaji. Katakana is converted to hiragana first. */
const KANA: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'o', ん: 'n\'',
  ゔ: 'vu', っ: '-cl-',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

/** Two-character combinations (base + small kana). */
const KANA2: Record<string, string> = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she', じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso', いぇ: 'ye',
};

export function katakanaToHiragana(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

export function hasKana(s: string): boolean {
  return /[ぁ-ゖァ-ヺー]/.test(s);
}

/** Converts kana text to space-separated romaji morae. Unknown characters are dropped. */
export function kanaToRomaji(text: string): string[] {
  const s = katakanaToHiragana(text);
  const out: string[] = [];
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const two = chars[i] + (chars[i + 1] ?? '');
    if (KANA2[two]) {
      out.push(KANA2[two]);
      i++;
      continue;
    }
    const ch = chars[i];
    if (ch === 'ー' || ch === '〜' || ch === '~') {
      out.push('-');
      continue;
    }
    const r = KANA[ch];
    if (r) out.push(r);
  }
  return out;
}

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);
const CONSONANTS = ['tsy', 'ky', 'gy', 'ny', 'hy', 'by', 'py', 'my', 'ry', 'sh', 'ch', 'ts', 'k', 'g', 's', 'z', 'j', 't', 'd', 'n', 'h', 'f', 'b', 'p', 'm', 'y', 'r', 'l', 'w', 'v', 'c', 'q', 'x'];

const ROMAJI_ALIASES: Record<string, string> = {
  si: 'shi', zi: 'ji', tu: 'tsu', hu: 'fu', sya: 'sha', syu: 'shu', syo: 'sho', zya: 'ja', zyu: 'ju', zyo: 'jo',
  tya: 'cha', tyu: 'chu', tyo: 'cho', jya: 'ja', jyu: 'ju', jyo: 'jo',
};

function consonantPhonemes(c: string): string[] {
  if (c === 'l') return JA_CONSONANT_MAP.r;
  if (c === 'c' || c === 'q') return JA_CONSONANT_MAP.k;
  if (c === 'x') return ['K', 'S'];
  if (c === 'tsy') return ['CH'];
  return JA_CONSONANT_MAP[c] ?? [];
}

/**
 * Converts romaji (Hepburn-ish) to phonemes. Returns null if the text is not parseable as romaji.
 * "n" before a consonant or at the end is the moraic nasal; doubled consonants become a closure.
 */
export function romajiToPhonemes(input: string, aliases = true): string[] | null {
  const s = input.toLowerCase().replace(/[^a-z']/g, '');
  if (!s) return null;
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      i++;
      continue;
    }
    if (VOWELS.has(s[i])) {
      out.push(s[i]);
      i++;
      continue;
    }
    // Moraic n: "n" followed by end, apostrophe, or a consonant other than y.
    if (s[i] === 'n') {
      const next = s[i + 1];
      if (next === undefined || next === "'" || (!VOWELS.has(next) && next !== 'y')) {
        out.push('NN');
        i += next === "'" ? 2 : 1;
        continue;
      }
    }
    // Geminate consonant.
    if (s[i] === s[i + 1] && !VOWELS.has(s[i]) && s[i] !== 'n') {
      out.push('cl');
      i++;
      continue;
    }
    let matched = false;
    for (const c of CONSONANTS) {
      if (s.startsWith(c, i)) {
        const rest = s.slice(i);
        // Apply aliases on the mora (consonant + vowel).
        const v = rest[c.length];
        if (v !== undefined && VOWELS.has(v)) {
          const mora = c + v;
          const alias = aliases ? ROMAJI_ALIASES[mora] : undefined;
          if (alias) {
            const a = romajiToPhonemes(alias, false);
            if (a) out.push(...a);
            i += mora.length;
            matched = true;
            break;
          }
          out.push(...consonantPhonemes(c), v);
          i += mora.length;
          matched = true;
          break;
        }
        // Consonant without vowel: keep it (e.g. "s" at the end).
        out.push(...consonantPhonemes(c));
        i += c.length;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
  return out;
}

export type JaResult = { kind: 'phonemes'; phonemes: string[] } | { kind: 'sustain' } | null;

export function japaneseToPhonemes(lyric: string): JaResult {
  const text = lyric.trim();
  if (!text) return null;
  if (hasKana(text)) {
    const morae = kanaToRomaji(text);
    if (morae.length === 1 && morae[0] === '-') return { kind: 'sustain' };
    const phs: string[] = [];
    for (const m of morae) {
      if (m === '-') continue;
      if (m === '-cl-') {
        phs.push('cl');
        continue;
      }
      if (m === "n'") {
        phs.push('NN');
        continue;
      }
      const p = romajiToPhonemes(m, false);
      if (p) phs.push(...p);
    }
    return phs.length > 0 ? { kind: 'phonemes', phonemes: phs } : null;
  }
  const p = romajiToPhonemes(text);
  return p && p.length > 0 ? { kind: 'phonemes', phonemes: p } : null;
}
