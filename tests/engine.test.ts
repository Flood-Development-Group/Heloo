import { beforeAll, describe, expect, it } from 'vitest';
import { createNote, createProject, type Project } from '../src/core/model';
import { PPQ, TempoMap } from '../src/core/time';
import { loadEnglishDictionary } from '../src/voice/english';
import { PitchModel } from '../src/engine/pitch';
import { timedNotes, splitPhrases } from '../src/engine/notes';
import { layoutPhrase } from '../src/engine/timing';
import { planProject, planTrack } from '../src/engine/plan';
import { renderBuiltin } from '../src/engine/render-builtin';

beforeAll(async () => {
  await loadEnglishDictionary();
});

function project(notes: [number, number, number, string][], opts: Partial<{ language: 'en' | 'ja'; vibrato: number; voice: string }> = {}): Project {
  const p = createProject();
  const t = p.tracks[0];
  t.language = opts.language ?? 'en';
  t.voiceParams.vibratoDepth = opts.vibrato ?? 0;
  if (opts.voice) t.voice = opts.voice;
  for (const [beat, beats, pitch, lyric] of notes) t.notes.push(createNote(beat * PPQ, beats * PPQ, pitch, lyric));
  return p;
}

function rms(x: Float32Array, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Autocorrelation pitch estimate in Hz. */
function estimateF0(x: Float32Array, fs: number, a: number, len = 4096, fmin = 70, fmax = 1200): number {
  const seg = x.subarray(a, a + len);
  let best = 0;
  let bestLag = 0;
  const minLag = Math.floor(fs / fmax);
  const maxLag = Math.ceil(fs / fmin);
  const corr = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    corr[lag] = s / (seg.length - lag);
  }
  // First peak above 90% of the global maximum avoids octave errors.
  let gmax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) gmax = Math.max(gmax, corr[lag]);
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (corr[lag] > 0.9 * gmax && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      bestLag = lag;
      best = corr[lag];
      break;
    }
  }
  expect(best).toBeGreaterThan(0);
  // Parabolic interpolation.
  const y0 = corr[bestLag - 1];
  const y1 = corr[bestLag];
  const y2 = corr[bestLag + 1];
  const shift = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2 || 1);
  return fs / (bestLag + shift);
}

/** Energy in a frequency band using a Hann-windowed DFT. */
function bandEnergy(x: Float32Array, fs: number, a: number, lo: number, hi: number, len = 2048): number {
  let e = 0;
  const kLo = Math.floor((lo * len) / fs);
  const kHi = Math.ceil((hi * len) / fs);
  for (let k = kLo; k <= kHi; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < len; n++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (len - 1));
      const v = x[a + n] * w;
      const ang = (-2 * Math.PI * k * n) / len;
      re += v * Math.cos(ang);
      im += v * Math.sin(ang);
    }
    e += re * re + im * im;
  }
  return e;
}

function renderSingle(p: Project) {
  const plans = planProject(p);
  const job = plans[0].jobs[0];
  const audio = renderBuiltin(job);
  return { job, audio, fs: job.sampleRate, at: (sec: number) => Math.round((sec - job.start) * job.sampleRate) };
}

describe('pitch model', () => {
  const tempo = new TempoMap([{ tick: 0, bpm: 120 }]);
  const curves = { pitchBend: [], vibratoEnv: [] };

  it('sits on the note pitch in the middle of a note (no vibrato)', () => {
    const p = project([[0, 4, 69, 'a']]);
    const pm = new PitchModel(timedNotes(p.tracks[0], tempo), curves, tempo);
    // Note spans 0..2 s; drift is at most ~0.07 semitones.
    for (const t of [0.5, 1, 1.5]) expect(Math.abs(pm.midiAt(t) - 69)).toBeLessThan(0.08);
    // Attack scoop starts below the note.
    expect(pm.midiAt(0)).toBeLessThan(68.8);
  });

  it('glides monotonically between connected notes', () => {
    const p = project([
      [0, 2, 60, 'a'],
      [2, 2, 67, 'a'],
    ]);
    const pm = new PitchModel(timedNotes(p.tracks[0], tempo), curves, tempo);
    expect(Math.abs(pm.midiAt(0.5) - 60)).toBeLessThan(0.1);
    expect(Math.abs(pm.midiAt(1.6) - 67)).toBeLessThan(0.1);
    const mid = pm.midiAt(1.0);
    expect(mid).toBeGreaterThan(61);
    expect(mid).toBeLessThan(66);
    // Overshoot goes slightly past the target, then settles.
    let peak = 0;
    for (let t = 1.0; t < 1.4; t += 0.005) peak = Math.max(peak, pm.midiAt(t));
    expect(peak).toBeGreaterThan(67.05);
    expect(peak).toBeLessThan(67.8);
  });

  it('applies vibrato at the requested rate and the pitch-bend curve', () => {
    const p = project([[0, 8, 69, 'a']], { vibrato: 0.5 });
    const tn = timedNotes(p.tracks[0], tempo);
    const pm = new PitchModel(tn, curves, tempo);
    const n = 2000;
    const out = new Float64Array(n);
    pm.fill(1.0, 0.001, out); // 1..3 s, vibrato fully faded in
    let crossings = 0;
    for (let i = 1; i < n; i++) if (out[i - 1] - 69 < 0 && out[i] - 69 >= 0) crossings++;
    // 5.5 Hz over 2 s ≈ 11 upward crossings.
    expect(crossings).toBeGreaterThanOrEqual(10);
    expect(crossings).toBeLessThanOrEqual(12);
    let max = -Infinity;
    for (const v of out) max = Math.max(max, v);
    expect(max - 69).toBeGreaterThan(0.4);
    expect(max - 69).toBeLessThan(0.65);

    const bent = new PitchModel(tn, { pitchBend: [[0, 100], [PPQ * 8, 100]], vibratoEnv: [[0, 0], [PPQ * 8, 0]] }, tempo);
    expect(Math.abs(bent.midiAt(2) - 70)).toBeLessThan(0.08);
  });
});

describe('phoneme layout', () => {
  const tempo = new TempoMap([{ tick: 0, bpm: 120 }]);

  it('puts onset consonants before the note and the vowel on the note', () => {
    const p = project([[1, 2, 60, 'star']]);
    const notes = timedNotes(p.tracks[0], tempo);
    const { segs, display } = layoutPhrase(notes, 'en');
    expect(segs.map((s) => s.ph)).toEqual(['S', 'T', 'AA', 'R']);
    const vowel = segs[2];
    expect(vowel.start).toBeCloseTo(0.5, 9);
    expect(segs[0].start).toBeLessThan(0.5);
    expect(segs[3].end).toBeCloseTo(1.5, 9);
    expect(display[0]).toEqual(['S', 'T', 'AA', 'R']);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end - 1e-12);
  });

  it('distributes syllables over "+" notes and sustains over "-" notes', () => {
    const p = project([
      [0, 1, 60, 'twinkle'],
      [1, 1, 62, '+'],
      [2, 1, 64, '-'],
    ]);
    const notes = timedNotes(p.tracks[0], tempo);
    const { segs, display } = layoutPhrase(notes, 'en');
    expect(segs.map((s) => s.ph)).toEqual(['T', 'W', 'IH', 'NG', 'K', 'AH', 'L']);
    const ah = segs.find((s) => s.ph === 'AH')!;
    expect(ah.start).toBeCloseTo(0.5, 9);
    const l = segs.find((s) => s.ph === 'L')!;
    expect(l.end).toBeCloseTo(1.5, 9); // coda moved to the end of the sustained note
    expect(display[2]).toEqual(['-']);
    // "K" must come before the second note starts.
    expect(segs.find((s) => s.ph === 'K')!.end).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('compresses consonants on very short notes without overlapping', () => {
    const p = project([
      [0, 0.125, 60, 'strengths'],
      [0.125, 0.125, 62, 'splints'],
    ]);
    const notes = timedNotes(p.tracks[0], tempo);
    const { segs } = layoutPhrase(notes, 'en');
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end - 1e-12);
    for (const s of segs) expect(s.end).toBeGreaterThan(s.start);
  });

  it('splits phrases at rests', () => {
    const p = project([
      [0, 1, 60, 'la'],
      [1, 1, 60, 'la'],
      [4, 1, 60, 'la'],
    ]);
    expect(splitPhrases(timedNotes(p.tracks[0], tempo)).map((ph) => ph.length)).toEqual([2, 1]);
  });
});

describe('built-in synthesizer', () => {
  it('sings a sustained vowel at the right pitch with sane levels', () => {
    const p = project([[0, 4, 69, 'ah']]);
    const { audio, fs, at } = renderSingle(p);
    for (let i = 0; i < audio.length; i++) if (!Number.isFinite(audio[i])) throw new Error(`NaN at ${i}`);
    let peak = 0;
    for (const v of audio) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.95);
    expect(peak).toBeGreaterThan(0.05);
    const level = rms(audio, at(0.5), at(1.5));
    expect(level).toBeGreaterThan(0.03);
    expect(level).toBeLessThan(0.4);
    // Silence well before the note.
    expect(rms(audio, 0, at(-0.25))).toBeLessThan(1e-4);
    const f0 = estimateF0(audio, fs, at(0.8));
    expect(Math.abs(1200 * Math.log2(f0 / 440))).toBeLessThan(15); // within 15 cents (drift is < 8)
  });

  it('tracks pitch across the vocal range for every built-in voice', () => {
    for (const voice of ['builtin:aria', 'builtin:leo', 'builtin:kit']) {
      for (const midi of [45, 57, 69, 79]) {
        const p = project([[0, 3, midi, 'a']], { voice });
        const { audio, fs, at } = renderSingle(p);
        const expected = 440 * Math.pow(2, (midi - 69) / 12);
        const f0 = estimateF0(audio, fs, at(0.7), 4096, Math.max(60, expected * 0.6), expected * 1.6);
        expect(Math.abs(1200 * Math.log2(f0 / expected)), `${voice} midi ${midi}`).toBeLessThan(20);
      }
    }
  });

  it('gives vowels distinct spectra (IY has more 2-3.5 kHz energy than AA)', () => {
    const iy = renderSingle(project([[0, 4, 57, 'ee']]));
    const aa = renderSingle(project([[0, 4, 57, 'ah']]));
    const ratio = (r: ReturnType<typeof renderSingle>) =>
      bandEnergy(r.audio, r.fs, r.at(1), 2200, 3500) / bandEnergy(r.audio, r.fs, r.at(1), 500, 1300);
    expect(ratio(iy)).toBeGreaterThan(ratio(aa) * 3);
  });

  it('produces high-frequency noise for "s"', () => {
    const r = renderSingle(project([[1, 2, 60, 'sa']]));
    const sSeg = r.job.segs.find((s) => s.ph === 'S')!;
    const mid = (sSeg.start + sSeg.end) / 2;
    const a = r.at(mid) - 1024;
    const high = bandEnergy(r.audio, r.fs, a, 4500, 9000);
    const low = bandEnergy(r.audio, r.fs, a, 100, 1500);
    expect(high).toBeGreaterThan(low * 5);
    expect(rms(r.audio, a, a + 2048)).toBeGreaterThan(0.005);
  });

  it('is deterministic and reasonably fast', () => {
    const p = project(
      Array.from({ length: 16 }, (_, i) => [i, 1, 60 + (i % 5), ['la', 'shine', 'go', 'yes'][i % 4]] as [number, number, number, string]),
    );
    const t0 = performance.now();
    const a = renderSingle(p).audio;
    const ms = performance.now() - t0;
    const b = renderSingle(p).audio;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 97) expect(a[i]).toBe(b[i]);
    const seconds = a.length / 44100;
    // Rendering must be much faster than real time (generous bound for slow CI machines).
    expect(ms / 1000).toBeLessThan(seconds);
  });

  it('renders Japanese and breath notes', () => {
    const r = renderSingle(project([
      [0, 1, 64, 'さ'],
      [1, 1, 64, 'く'],
      [2, 2, 67, 'ら'],
    ], { language: 'ja' }));
    expect(r.job.segs.map((s) => s.ph)).toEqual(['S', 'a', 'K', 'u', 'DX', 'a']);
    expect(rms(r.audio, r.at(0.2), r.at(1.8))).toBeGreaterThan(0.02);
    const br = renderSingle(project([[0, 1, 60, 'br']]));
    expect(rms(br.audio, br.at(0.1), br.at(0.4))).toBeGreaterThan(0.001);
  });
});

describe('render plan', () => {
  it('only changes the key of the edited phrase', () => {
    const p = project([
      [0, 1, 60, 'la'],
      [1, 1, 62, 'la'],
      [6, 1, 64, 'la'],
    ]);
    const tempo = new TempoMap(p.tempos);
    const before = planTrack(p.tracks[0], tempo).jobs.map((j) => j.key);
    expect(before).toHaveLength(2);
    p.tracks[0].notes[2].lyric = 'lo';
    const after = planTrack(p.tracks[0], tempo).jobs.map((j) => j.key);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    // Curves outside a phrase do not affect it.
    p.tracks[0].params.loudness = [[PPQ * 6, -6], [PPQ * 7, -6]];
    const curved = planTrack(p.tracks[0], tempo).jobs.map((j) => j.key);
    expect(curved[0]).toBe(before[0]);
    expect(curved[1]).not.toBe(after[1]);
  });
});

describe('sliceCurve', () => {
  it('reproduces the curve inside the range exactly', async () => {
    const { sliceCurve } = await import('../src/engine/plan');
    const { sampleCurve } = await import('../src/core/curves');
    const cases: [number, number][][] = [
      [],
      [[0, 1], [100, 2]],
      [[-50, 1], [500, 3]],
      [[200, 5], [300, 6]],
      [[10, 1], [20, 2], [400, 0], [450, 9]],
      [[-100, 4]],
    ];
    for (const pts of cases) {
      const s = sliceCurve(pts as [number, number][], 0, 250);
      for (let t = 0; t <= 250; t += 5) expect(sampleCurve(s, t, 0)).toBeCloseTo(sampleCurve(pts as [number, number][], t, 0), 12);
    }
    expect(sliceCurve([[300, 1], [400, 2]], 0, 250)).toEqual([]);
  });
});
