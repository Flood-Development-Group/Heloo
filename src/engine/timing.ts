import type { Language } from '../core/model';
import { isSonorant, isVowel, phonemeDef } from '../voice/phonemes';
import { phonemizeLyric, syllabify as syllabifyWith, type LyricResult, type Syllable } from '../voice/phonemizer';
import { CONNECT_GAP, PHRASE_PREROLL, type TimedNote } from './notes';

export type SegRole = 'onset' | 'nucleus' | 'coda' | 'breath';

/** A phoneme placed in time (seconds). */
export interface PhSeg {
  ph: string;
  start: number;
  end: number;
  /** Index of the note (within the phrase) this phoneme belongs to. */
  note: number;
  role: SegRole;
}

export interface PhraseLayout {
  segs: PhSeg[];
  /** Phonemes shown under each note (sustained notes show "-"). */
  display: string[][];
}

interface Span {
  syl: Syllable;
  /** Vowel start (seconds). */
  a: number;
  /** Span end (seconds). */
  b: number;
  note: number;
  breath: boolean;
}

/** How a voice turns lyrics into phonemes and how long its consonants are. */
export interface Phonology {
  phonemize(lyric: string, override: string | undefined): LyricResult;
  isVowel(ph: string): boolean;
  isSonorant(ph: string): boolean;
  /** Default duration of a consonant, seconds. */
  duration(ph: string): number;
  /** Symbol used for breath notes. */
  breath: string;
  defaultVowel: string;
}

/** The phonology of the built-in voices. */
export function builtinPhonology(lang: Language): Phonology {
  return {
    phonemize: (lyric, override) => phonemizeLyric(lyric, lang, override),
    isVowel,
    isSonorant,
    duration: (ph) => phonemeDef(ph)?.dur ?? 0.06,
    breath: 'br',
    defaultVowel: lang === 'ja' ? 'a' : 'AA',
  };
}

/** Converts lyrics into phonemes and places them in time for one phrase. */
export function layoutPhrase(notes: readonly TimedNote[], lang: Language, phonology: Phonology = builtinPhonology(lang)): PhraseLayout {
  const ph = phonology;
  const phDur = (p: string) => ph.duration(p);
  const defaultVowel = () => ph.defaultVowel;
  const syllabify = (phs: string[]) => syllabifyWith(phs, ph.isVowel, ph.isSonorant);
  const results: LyricResult[] = notes.map((n) => ph.phonemize(n.lyric, n.phonemes));
  const display: string[][] = notes.map(() => []);

  // 1. Group notes into words: a word note followed by "+" (next syllable) and "-" (sustain) notes.
  interface Group {
    breath: boolean;
    notes: number[];
    slots: number[];
    syllables: Syllable[];
  }
  const groups: Group[] = [];
  for (let i = 0; i < notes.length; i++) {
    const r = results[i];
    const g = groups[groups.length - 1];
    if (r.kind === 'phonemes') {
      const syl = syllabify(r.phonemes);
      groups.push({ breath: false, notes: [i], slots: [i], syllables: syl.length ? syl : [{ onset: [], nucleus: defaultVowel(), coda: [] }] });
    } else if (r.kind === 'breath') {
      groups.push({ breath: true, notes: [i], slots: [i], syllables: [{ onset: [], nucleus: ph.breath, coda: [] }] });
    } else if (g && !g.breath) {
      g.notes.push(i);
      if (r.kind === 'continue') g.slots.push(i);
    } else {
      groups.push({ breath: false, notes: [i], slots: [i], syllables: [{ onset: [], nucleus: defaultVowel(), coda: [] }] });
    }
  }

  // 2. Assign syllables to notes and build time spans.
  const spans: Span[] = [];
  for (const g of groups) {
    const perSlot = new Map<number, Syllable[]>();
    g.syllables.forEach((s, j) => {
      const slot = g.slots[Math.min(j, g.slots.length - 1)];
      const list = perSlot.get(slot) ?? [];
      list.push(s);
      perSlot.set(slot, list);
    });
    for (const ni of g.notes) {
      const n = notes[ni];
      const syls = perSlot.get(ni);
      if (!syls || syls.length === 0) {
        // Sustain: extend the previous span of this word.
        const last = spans[spans.length - 1];
        if (last) last.b = n.end;
        display[ni] = ['-'];
        continue;
      }
      const len = (n.end - n.start) / syls.length;
      syls.forEach((syl, k) => {
        spans.push({ syl, a: n.start + k * len, b: n.start + (k + 1) * len, note: ni, breath: g.breath });
        display[ni].push(...syl.onset, syl.nucleus, ...syl.coda);
      });
    }
  }

  // 3. Fit consonants around vowel onsets.
  const sum = (phs: string[]) => phs.reduce((acc, p) => acc + phDur(p), 0);
  const onsetScale = new Float64Array(spans.length).fill(1);
  const codaScale = new Float64Array(spans.length).fill(1);
  const codaEnd = new Float64Array(spans.length);
  const minVowel = spans.map((s) => Math.min(0.12, Math.max(0.03, 0.3 * (s.b - s.a))));
  for (let j = 0; j < spans.length; j++) {
    const s = spans[j];
    const dOn = sum(s.syl.onset);
    const prev = spans[j - 1];
    if (!prev) {
      onsetScale[j] = dOn > PHRASE_PREROLL ? PHRASE_PREROLL / dOn : 1;
    } else {
      const dCoPrev = sum(prev.syl.coda);
      const connected = s.a - prev.b < CONNECT_GAP;
      if (connected) {
        const region = Math.max(0, s.a - (prev.a + minVowel[j - 1]));
        const need = dCoPrev + dOn;
        const f = need > region ? region / need : 1;
        codaScale[j - 1] = f;
        onsetScale[j] = f;
        codaEnd[j - 1] = s.a - dOn * f;
      } else {
        const regionC = Math.max(0, prev.b - (prev.a + minVowel[j - 1]));
        codaScale[j - 1] = dCoPrev > regionC ? regionC / dCoPrev : 1;
        codaEnd[j - 1] = prev.b;
        const regionO = Math.min(PHRASE_PREROLL, s.a - prev.b);
        onsetScale[j] = dOn > regionO ? Math.max(0, regionO) / dOn : 1;
      }
    }
  }
  const lastIdx = spans.length - 1;
  if (lastIdx >= 0) {
    const s = spans[lastIdx];
    const dCo = sum(s.syl.coda);
    const region = Math.max(0, s.b - (s.a + minVowel[lastIdx]));
    codaScale[lastIdx] = dCo > region ? region / dCo : 1;
    codaEnd[lastIdx] = s.b;
  }

  // 4. Emit segments.
  const segs: PhSeg[] = [];
  const push = (ph: string, start: number, end: number, note: number, role: SegRole) => {
    if (end - start < 0.001) return;
    const last = segs[segs.length - 1];
    const st = last ? Math.max(start, last.end) : start;
    if (end - st < 0.001) return;
    segs.push({ ph, start: st, end, note, role });
  };
  spans.forEach((s, j) => {
    const fo = onsetScale[j];
    let t = s.a - sum(s.syl.onset) * fo;
    for (const p of s.syl.onset) {
      const d = phDur(p) * fo;
      push(p, t, t + d, s.note, 'onset');
      t += d;
    }
    const fc = codaScale[j];
    const cEnd = codaEnd[j];
    const cStart = cEnd - sum(s.syl.coda) * fc;
    push(s.syl.nucleus, s.a, Math.max(s.a, cStart), s.note, s.breath ? 'breath' : 'nucleus');
    let tc = cStart;
    for (const p of s.syl.coda) {
      const d = phDur(p) * fc;
      push(p, tc, tc + d, s.note, 'coda');
      tc += d;
    }
  });
  return { segs, display };
}
