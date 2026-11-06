import { beforeAll, describe, expect, it } from 'vitest';
import { createNote, createProject } from '../src/core/model';
import { PPQ } from '../src/core/time';
import { planProject } from '../src/engine/plan';
import { buildAcousticInputs, loadVoicebank, renderDiffSinger, setOrtLoader } from '../src/engine/neural/diffsinger';
import { readVoicebank, unzipVoicebank, voicebankPhonology, joinPath } from '../src/engine/neural/voicebank';
import { buildMockVoicebankZip } from './fixtures/mock-voicebank';

beforeAll(() => {
  // The browser build loads WebAssembly via URL; in Node use the Node build of ONNX Runtime Web.
  setOrtLoader(async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    return ort;
  });
});

function jaProject(lyrics: string[], voice = 'ds:mock') {
  const p = createProject();
  const t = p.tracks[0];
  t.voice = voice;
  t.language = 'ja';
  t.voiceParams.vibratoDepth = 0;
  lyrics.forEach((l, i) => t.notes.push(createNote(PPQ * (1 + i), PPQ, 69, l)));
  return p;
}

describe('voicebank reading', () => {
  it('parses config, phonemes, dictionary, vocoder and name', () => {
    const vb = readVoicebank(unzipVoicebank(buildMockVoicebankZip()));
    expect(vb.name).toBe('Mock Singer');
    expect(vb.root).toBe('MockSinger/');
    expect(vb.phonemes.get('SP')).toBe(1);
    expect(vb.phonemes.get('a')).toBe(3);
    expect(vb.dicts.get('')?.entries.get('か')).toEqual(['k', 'a']);
    expect(vb.vocoderConfig.model).toBe('mock.onnx');
    expect(vb.warnings).toEqual([]);
  });

  it('explains a missing vocoder', () => {
    expect(() => readVoicebank(unzipVoicebank(buildMockVoicebankZip({ withVocoder: false })))).toThrow(/needs a vocoder/);
  });

  it('rejects zips without a DiffSinger config', () => {
    expect(() => unzipVoicebank(new Uint8Array([1, 2, 3]))).toThrow(/not a valid zip/);
  });

  it('warns and falls back to built-in pronunciations without a dictionary', () => {
    const vb = readVoicebank(unzipVoicebank(buildMockVoicebankZip({ withDict: false })));
    expect(vb.warnings.join(' ')).toMatch(/dsdict/);
    const ph = voicebankPhonology(vb, 'ja');
    expect(ph.phonemize('か', undefined)).toEqual({ kind: 'phonemes', phonemes: ['k', 'a'] });
    expect(ph.isVowel('a')).toBe(true);
    expect(ph.isVowel('k')).toBe(false);
  });

  it('normalises relative paths', () => {
    expect(joinPath('a/b/', '../c/./d.onnx')).toBe('a/c/d.onnx');
  });
});

describe('acoustic inputs', () => {
  it('builds tokens with silence padding and frame durations that match the phrase', () => {
    const vb = readVoicebank(unzipVoicebank(buildMockVoicebankZip()));
    const job = planProject(jaProject(['か', 'さ']))[0].jobs[0];
    const inp = buildAcousticInputs(job, vb);
    expect(inp.tokenSymbols).toEqual(['SP', 'k', 'a', 's', 'a', 'SP']);
    const sum = Array.from(inp.durations).reduce((a, b) => a + Number(b), 0);
    expect(sum).toBe(inp.frames);
    // The first vowel starts on the note (beat 1 at 120 bpm = 0.5 s).
    const frameOfVowel = Number(inp.durations[0]) + Number(inp.durations[1]);
    expect(Math.abs((job.start + (frameOfVowel * 512) / 44100) - 0.5)).toBeLessThan(512 / 44100);
    expect(inp.f0.length).toBe(inp.frames);
    expect(Math.abs(inp.f0[Math.round((0.75 - job.start) / (512 / 44100))] - 440)).toBeLessThan(5);
  });

  it('reports phonemes the voicebank does not have', () => {
    const vb = readVoicebank(unzipVoicebank(buildMockVoicebankZip()));
    const p = jaProject(['か']);
    p.tracks[0].notes[0].phonemes = 'zz a';
    const job = planProject(p)[0].jobs[0];
    // "zz" is unknown and dropped by the override resolver; only "a" remains.
    expect(buildAcousticInputs(job, vb).tokenSymbols).toEqual(['SP', 'a', 'SP']);
  });
});

describe('DiffSinger rendering through ONNX Runtime', () => {
  it('loads the models and renders a phrase of the right length', async () => {
    const info = await loadVoicebank('ds:mock', { 'voicebank.zip': buildMockVoicebankZip() });
    expect(info.name).toBe('Mock Singer');
    const job = planProject(jaProject(['か', 'さ', 'ま']))[0].jobs[0];
    const audio = await renderDiffSinger(job);
    expect(audio.length).toBe(Math.round((job.end - job.start) * job.sampleRate));
    let finite = true;
    let max = 0;
    for (const v of audio) {
      if (!Number.isFinite(v)) finite = false;
      max = Math.max(max, Math.abs(v));
    }
    expect(finite).toBe(true);
    // The mock vocoder outputs 0.001·f0 ≈ 0.44 for A4.
    expect(max).toBeGreaterThan(0.3);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('fails clearly when the voicebank is not loaded', async () => {
    const job = planProject(jaProject(['か'], 'ds:other'))[0].jobs[0];
    await expect(renderDiffSinger(job)).rejects.toThrow(/not loaded/);
  });
});
