import { beforeAll, describe, expect, it } from 'vitest';
import { englishLetterToSound, loadEnglishDictionary, lookupEnglish } from '../src/voice/english';
import { kanaToRomaji, romajiToPhonemes } from '../src/voice/japanese';
import { phonemizeLyric, syllabify } from '../src/voice/phonemizer';
import { PHONEMES } from '../src/voice/phonemes';

beforeAll(async () => {
  await loadEnglishDictionary();
});

function phs(lyric: string, lang: 'en' | 'ja' = 'en'): string[] {
  const r = phonemizeLyric(lyric, lang);
  if (r.kind !== 'phonemes') throw new Error(`expected phonemes, got ${r.kind}`);
  return r.phonemes;
}

describe('English', () => {
  it('uses the CMU dictionary without stress markers', () => {
    expect(lookupEnglish('Hello')).toEqual(['HH', 'AH', 'L', 'OW']);
    expect(phs('star')).toEqual(['S', 'T', 'AA', 'R']);
    expect(phs("don't")).toEqual(['D', 'OW', 'N', 'T']);
  });

  it('falls back to letter-to-sound rules for unknown words', () => {
    expect(englishLetterToSound('blorp')).toEqual(['B', 'L', 'AO', 'R', 'P']);
    expect(englishLetterToSound('zake')).toEqual(['Z', 'EY', 'K']);
    expect(englishLetterToSound('shimmy')).toEqual(['SH', 'IH', 'M', 'IY']);
    expect(phs('flurbington').length).toBeGreaterThan(5);
  });

  it('produces only known phoneme symbols for many words', () => {
    for (const w of ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'xylophone', 'rhythm', 'qwzx', 'aeiou', 'strengths']) {
      for (const p of phs(w)) expect(PHONEMES.has(p), `${w}: ${p}`).toBe(true);
    }
  });
});

describe('Japanese', () => {
  it('converts kana including small kana, sokuon and moraic n', () => {
    expect(kanaToRomaji('きゃっと')).toEqual(['kya', '-cl-', 'to']);
    expect(phs('か', 'ja')).toEqual(['K', 'a']);
    expect(phs('カ', 'ja')).toEqual(['K', 'a']);
    expect(phs('しゃ', 'ja')).toEqual(['SH', 'a']);
    expect(phs('ん', 'ja')).toEqual(['NN']);
    expect(phs('つ', 'ja')).toEqual(['TS', 'u']);
    expect(phs('ら', 'ja')).toEqual(['DX', 'a']);
    expect(phs('きゃ', 'ja')).toEqual(['K', 'Y', 'a']);
    expect(phs('とぅ', 'ja')).toEqual(['T', 'u']);
    expect(phonemizeLyric('ー', 'ja').kind).toBe('sustain');
  });

  it('parses romaji', () => {
    expect(romajiToPhonemes('shi')).toEqual(['SH', 'i']);
    expect(romajiToPhonemes('si')).toEqual(['SH', 'i']);
    expect(romajiToPhonemes('tsu')).toEqual(['TS', 'u']);
    expect(romajiToPhonemes("kon'nichiwa")).toEqual(['K', 'o', 'NN', 'N', 'i', 'CH', 'i', 'W', 'a']);
    expect(romajiToPhonemes('kka')).toEqual(['cl', 'K', 'a']);
    expect(romajiToPhonemes('san')).toEqual(['S', 'a', 'NN']);
    expect(romajiToPhonemes('la')).toEqual(['DX', 'a']);
    expect(phs('a', 'ja')).toEqual(['a']);
  });

  it('produces only known phoneme symbols for every kana', () => {
    const all = 'あいうえおかきくけこがぎぐげごさしすせそざじずぜぞたちつてとだぢづでどなにぬねのはひふへほばびぶべぼぱぴぷぺぽまみむめもやゆよらりるれろわをんゔ';
    for (const ch of all) {
      for (const p of phs(ch, 'ja')) expect(PHONEMES.has(p), `${ch}: ${p}`).toBe(true);
    }
  });
});

describe('special lyrics and overrides', () => {
  it('recognises sustain, continue, breath, phoneme input and overrides', () => {
    expect(phonemizeLyric('-', 'en').kind).toBe('sustain');
    expect(phonemizeLyric('', 'en').kind).toBe('sustain');
    expect(phonemizeLyric('+', 'en').kind).toBe('continue');
    expect(phonemizeLyric('br', 'en').kind).toBe('breath');
    expect(phs('.hh ah l ow')).toEqual(['HH', 'AH', 'L', 'OW']);
    expect(phonemizeLyric('la', 'en', 'k aa')).toEqual({ kind: 'phonemes', phonemes: ['K', 'AA'] });
    expect(phonemizeLyric('la', 'ja', 'k a')).toEqual({ kind: 'phonemes', phonemes: ['K', 'a'] });
  });
});

describe('syllabify', () => {
  it('splits multi-syllable words', () => {
    const s = syllabify(phs('twinkle'));
    expect(s).toEqual([
      { onset: ['T', 'W'], nucleus: 'IH', coda: ['NG'] },
      { onset: ['K'], nucleus: 'AH', coda: ['L'] },
    ]);
    expect(syllabify(phs('little')).map((x) => x.nucleus)).toEqual(['IH', 'AH']);
    expect(syllabify(['S', 'T', 'AA', 'R'])).toEqual([{ onset: ['S', 'T'], nucleus: 'AA', coda: ['R'] }]);
  });

  it('handles words without vowels', () => {
    expect(syllabify(['NN'])).toEqual([{ onset: [], nucleus: 'NN', coda: [] }]);
    expect(syllabify(['SH'])).toEqual([{ onset: [], nucleus: 'SH', coda: [] }]);
    expect(syllabify(['HH', 'M'])).toEqual([{ onset: ['HH'], nucleus: 'M', coda: [] }]);
  });
});
