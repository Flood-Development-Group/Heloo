/**
 * Opt-in test with real DiffSinger voicebanks (they are large and not redistributable, so they are
 * never committed). Point HELOO_VOICEBANK_DIR at a folder containing voicebank .zip files and a
 * vocoder package (a folder or .zip/.oudep with vocoder.yaml + .onnx), then run:
 *   HELOO_VOICEBANK_DIR=/path/to/voicebanks npx vitest run tests/real-voicebank.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNote, createProject } from '../src/core/model';
import { PPQ } from '../src/core/time';
import { planProject } from '../src/engine/plan';
import { buildAcousticInputs, clearVocoderPackages, loadVocoderPackage, loadVoicebank, renderDiffSinger, setOrtLoader } from '../src/engine/neural/diffsinger';
import { readVoicebank, unzipVoicebank } from '../src/engine/neural/voicebank';

const DIR = process.env.HELOO_VOICEBANK_DIR ?? '';
const enabled = DIR !== '' && existsSync(DIR);

function vocoderFiles(dir: string): Record<string, Uint8Array> | null {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory() && existsSync(join(p, 'vocoder.yaml'))) {
      const files: Record<string, Uint8Array> = {};
      for (const f of readdirSync(p)) if (statSync(join(p, f)).isFile()) files[`${entry}/${f}`] = new Uint8Array(readFileSync(join(p, f)));
      return files;
    }
    if (/\.(oudep)$/i.test(entry)) return { [entry]: new Uint8Array(readFileSync(p)) };
  }
  return null;
}

/** Autocorrelation pitch estimate (Hz) in a window. */
function f0At(x: Float32Array, fs: number, center: number, lo = 80, hi = 900): number {
  const len = 4096;
  const a = Math.max(0, Math.round(center * fs) - len / 2);
  const seg = x.subarray(a, a + len);
  const minLag = Math.floor(fs / hi);
  const maxLag = Math.ceil(fs / lo);
  const corr = new Float64Array(maxLag + 2);
  let gmax = 0;
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    corr[lag] = s / (seg.length - lag);
    if (lag <= maxLag) gmax = Math.max(gmax, corr[lag]);
  }
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (corr[lag] > 0.85 * gmax && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      const y0 = corr[lag - 1], y1 = corr[lag], y2 = corr[lag + 1];
      return fs / (lag + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2 || 1));
    }
  }
  return NaN;
}

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

describe.runIf(enabled)('real DiffSinger voicebanks', () => {
  const zips = enabled ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.zip')) : [];

  it('finds voicebanks and a vocoder', () => {
    expect(zips.length).toBeGreaterThan(0);
    expect(vocoderFiles(DIR)).not.toBeNull();
  });

  for (const zip of zips) {
    it(`renders ${zip} at the right pitch`, async () => {
      setOrtLoader(async () => {
        const ort = await import('onnxruntime-web');
        ort.env.wasm.numThreads = 1;
        return ort;
      });
      clearVocoderPackages();
      const voc = loadVocoderPackage(vocoderFiles(DIR)!);
      expect(voc.sampleRate).toBe(44100);
      const bytes = new Uint8Array(readFileSync(join(DIR, zip)));
      const data = readVoicebank(unzipVoicebank(bytes), vocoderFiles(DIR)!);
      console.log(`${zip}: "${data.name}", ${data.phonemes.size} phonemes, dicts: ${[...data.dicts.keys()].map((k) => k || 'default').join(', ')}`);
      const id = `ds:${zip}`;
      const t0 = Date.now();
      const info = await loadVoicebank(id, { [zip]: bytes });
      console.log(`  loaded in ${Date.now() - t0} ms; warnings: ${info.warnings.join(' | ') || 'none'}`);

      // Four pinyin syllables, one beat each at 120 bpm, rising by whole tones.
      const p = createProject();
      const t = p.tracks[0];
      t.voice = id;
      t.language = 'en';
      t.voiceParams.vibratoDepth = 0;
      const syllables = ['ni', 'hao', 'ma', 'la'];
      const pitches = [60, 62, 64, 65];
      syllables.forEach((s, i) => t.notes.push(createNote(PPQ * (2 + i), PPQ, pitches[i], s)));
      const job = planProject(p)[0].jobs[0];
      const inp = buildAcousticInputs(job, data);
      console.log(`  tokens: ${inp.tokenSymbols.join(' ')}`);

      const t1 = Date.now();
      const audio = await renderDiffSinger(job);
      const seconds = (job.end - job.start);
      console.log(`  rendered ${seconds.toFixed(2)} s of audio in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      expect(audio.length).toBe(Math.round(seconds * job.sampleRate));
      expect(audio.every((v) => Number.isFinite(v))).toBe(true);

      const fs = job.sampleRate;
      const at = (sec: number) => sec - job.start;
      for (let i = 0; i < 4; i++) {
        const mid = 1 + i * 0.5 + 0.3; // note i spans [1 + 0.5i, 1.5 + 0.5i] s
        const expected = 440 * Math.pow(2, (pitches[i] - 69) / 12);
        const f0 = f0At(audio, fs, at(mid));
        const cents = 1200 * Math.log2(f0 / expected);
        console.log(`  note ${i} "${syllables[i]}": expected ${expected.toFixed(1)} Hz, measured ${f0.toFixed(1)} Hz (${cents.toFixed(0)} cents), rms ${rms(audio, Math.round(at(mid) * fs) - 2048, Math.round(at(mid) * fs) + 2048).toFixed(4)}`);
        expect(Math.abs(cents)).toBeLessThan(50);
      }
      const voiced = rms(audio, Math.round(at(1.2) * fs), Math.round(at(2.8) * fs));
      const lead = rms(audio, 0, Math.round(at(0.75) * fs));
      console.log(`  voiced rms ${voiced.toFixed(4)}, lead-in rms ${lead.toFixed(5)}`);
      expect(voiced).toBeGreaterThan(0.01);
      expect(lead).toBeLessThan(voiced / 5);
    }, 900_000);
  }
});
