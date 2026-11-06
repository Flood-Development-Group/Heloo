import type * as OrtNS from 'onnxruntime-web';
import { sampleCurveSorted } from '../../core/curves';
import { TempoMap } from '../../core/time';
import { PitchModel, midiToHz } from '../pitch';
import type { RenderJob } from '../plan';
import { layoutPhrase } from '../timing';
import { ensureLanguage, languageReady } from '../../voice/phonemizer';
import { readVoicebank, unzipVoicebank, voicebankPhonology, VoicebankError, type VoicebankData } from './voicebank';

/**
 * On-device neural singing with DiffSinger-format voicebanks, run through ONNX Runtime Web
 * (WebAssembly). Phoneme timing comes from Heloo's own layout rules and pitch from Heloo's
 * pitch model; the acoustic model predicts a mel spectrogram and the vocoder turns it into audio.
 */

type Ort = typeof OrtNS;

let ortLoader: () => Promise<Ort> = async () => {
  const ort = (await import('onnxruntime-web/wasm')) as unknown as Ort;
  // Single-threaded: iPad Safari pages are not cross-origin isolated, so no SharedArrayBuffer.
  ort.env.wasm.numThreads = 1;
  // The runtime's WebAssembly files are shipped in ./ort/ next to the app (see vite.config.ts).
  ort.env.wasm.wasmPaths = new URL(/* @vite-ignore */ '../ort/', import.meta.url).href;
  return ort;
};
let ortPromise: Promise<Ort> | null = null;

/** Lets tests use the Node build of ONNX Runtime. */
export function setOrtLoader(loader: () => Promise<Ort>): void {
  ortLoader = loader;
  ortPromise = null;
}

function getOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = ortLoader().catch((err: unknown) => {
      ortPromise = null;
      throw err;
    });
  }
  return ortPromise;
}

interface Loaded {
  data: VoicebankData;
  acoustic: OrtNS.InferenceSession;
  vocoder: OrtNS.InferenceSession;
}

const banks = new Map<string, Loaded>();

export interface VoicebankInfo {
  name: string;
  warnings: string[];
  phonemes: number;
  sampleRate: number;
}

export async function loadVoicebank(id: string, files: Record<string, ArrayBuffer | Uint8Array>): Promise<VoicebankInfo> {
  const all: Record<string, Uint8Array> = {};
  for (const [name, buf] of Object.entries(files)) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (name.toLowerCase().endsWith('.zip')) Object.assign(all, unzipVoicebank(bytes));
    else all[name] = bytes;
  }
  const data = readVoicebank(all);
  const ort = await getOrt();
  const opts: OrtNS.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  let acoustic: OrtNS.InferenceSession;
  let vocoder: OrtNS.InferenceSession;
  try {
    acoustic = await ort.InferenceSession.create(data.acousticModel, opts);
  } catch (err) {
    throw new VoicebankError(`The acoustic model could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    vocoder = await ort.InferenceSession.create(data.vocoderModel, opts);
  } catch (err) {
    await acoustic.release().catch(() => {});
    throw new VoicebankError(`The vocoder could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  const known = new Set(['tokens', 'durations', 'f0', 'languages', 'speedup', 'steps', 'depth', 'gender', 'velocity', 'energy', 'breathiness', 'voicing', 'tension', 'spk_embed']);
  const unknown = acoustic.inputNames.filter((n) => !known.has(n));
  for (const required of ['tokens', 'durations', 'f0']) {
    if (!acoustic.inputNames.includes(required)) unknown.push(`(missing “${required}”)`);
  }
  if (unknown.length > 0) {
    await acoustic.release().catch(() => {});
    await vocoder.release().catch(() => {});
    throw new VoicebankError(`Unsupported acoustic model inputs: ${unknown.join(', ')}. Only DiffSinger acoustic models exported for OpenUtau are supported.`);
  }
  const warnings = [...data.warnings];
  for (const v of ['energy', 'breathiness', 'voicing', 'tension']) {
    if (acoustic.inputNames.includes(v)) warnings.push(`The model expects a “${v}” curve, normally predicted by a variance model; Heloo supplies an approximation from its own curves.`);
  }
  // Free the model bytes now that sessions hold them.
  data.acousticModel = new Uint8Array(0);
  data.vocoderModel = new Uint8Array(0);
  const prev = banks.get(id);
  if (prev) unloadVoicebank(id);
  banks.set(id, { data, acoustic, vocoder });
  return { name: data.name, warnings, phonemes: data.phonemes.size, sampleRate: data.config.sample_rate ?? 44100 };
}

export function unloadVoicebank(id: string): void {
  const b = banks.get(id);
  if (!b) return;
  banks.delete(id);
  void b.acoustic.release().catch(() => {});
  void b.vocoder.release().catch(() => {});
}

export function isVoicebankLoaded(id: string): boolean {
  return banks.has(id);
}

/** Turns a phrase into acoustic-model inputs. Exported for testing. */
export function buildAcousticInputs(job: RenderJob, data: VoicebankData) {
  const cfg = data.config;
  const sr = cfg.sample_rate ?? 44100;
  const hop = cfg.hop_size ?? 512;
  const dt = hop / sr;
  const frames = Math.max(1, Math.round((job.end - job.start) / dt));
  const phonology = voicebankPhonology(data, job.language);
  const layout = layoutPhrase(job.notes, job.language, phonology);
  const toFrame = (t: number) => Math.min(frames, Math.max(0, Math.round((t - job.start) / dt)));

  // Tokens: silence ("SP") fills every gap, including the head and tail of the phrase.
  const silence = data.phonemes.has('SP') ? 'SP' : data.phonemes.has('<PAD>') ? '<PAD>' : [...data.phonemes.keys()][0];
  const seq: { ph: string; a: number; b: number }[] = [];
  let cursor = 0;
  for (const seg of layout.segs) {
    const a = toFrame(seg.start);
    const b = toFrame(seg.end);
    if (a > cursor) seq.push({ ph: silence, a: cursor, b: a });
    if (b > Math.max(a, cursor)) seq.push({ ph: seg.ph, a: Math.max(a, cursor), b });
    cursor = Math.max(cursor, b);
  }
  if (cursor < frames) seq.push({ ph: silence, a: cursor, b: frames });
  // Merge zero-length leftovers into neighbours by construction (only b > a pushed).
  const unknown = [...new Set(seq.map((s) => s.ph).filter((p) => !data.phonemes.has(p)))];
  if (unknown.length > 0) throw new VoicebankError(`These phonemes are not in the voicebank: ${unknown.join(', ')}. Edit the note’s phonemes in the inspector.`);
  const tokens = BigInt64Array.from(seq.map((s) => BigInt(data.phonemes.get(s.ph)!)));
  const durations = BigInt64Array.from(seq.map((s) => BigInt(s.b - s.a)));
  const total = seq.reduce((acc, s) => acc + (s.b - s.a), 0);
  if (total !== frames) throw new Error(`internal: durations sum to ${total}, expected ${frames}`);

  let languages: BigInt64Array | null = null;
  if (data.languages) {
    languages = BigInt64Array.from(
      seq.map((s) => {
        const prefix = s.ph.includes('/') ? s.ph.slice(0, s.ph.indexOf('/')) : job.language;
        return BigInt(data.languages!.get(prefix) ?? 0);
      }),
    );
  }

  const tempo = new TempoMap(job.tempos);
  const pitch = new PitchModel(job.notes, { pitchBend: job.curves.pitchBend, vibratoEnv: job.curves.vibratoEnv }, tempo);
  const midi = new Float64Array(frames);
  pitch.fill(job.start, dt, midi);
  const f0 = Float32Array.from(midi, (m) => midiToHz(m));
  const ticks = new Float64Array(frames);
  for (let k = 0; k < frames; k++) ticks[k] = tempo.secToTick(job.start + k * dt);
  const sample = (name: keyof RenderJob['curves'], def: number) => {
    const out = new Float64Array(frames);
    sampleCurveSorted(job.curves[name], ticks, def, out);
    return out;
  };
  const gender = sample('gender', 0);
  const breath = sample('breathiness', 0);
  const tension = sample('tension', 0);
  const loudness = sample('loudness', 0);
  const vp = job.voiceParams;
  const range = cfg.augmentation_args?.random_pitch_shifting?.range ?? [-5, 5];
  const keyShiftMax = Math.max(Math.abs(range[0]), Math.abs(range[1]));
  return {
    frames,
    sr,
    hop,
    tokens,
    durations,
    languages,
    f0,
    // Heloo's gender (+ = deeper) maps to a negative key shift.
    keyShift: Float32Array.from(gender, (g) => -Math.max(-1, Math.min(1, g + vp.gender)) * keyShiftMax),
    breathinessDb: Float32Array.from(breath, (b) => -60 + 25 * Math.max(-1, Math.min(1, b + vp.breathiness))),
    tensionLogit: Float32Array.from(tension, (t) => 3 * Math.max(-1, Math.min(1, t + vp.tension))),
    energyDb: Float32Array.from(loudness, (l) => -20 + 0.5 * l),
    loudnessGain: Float32Array.from(loudness, (l) => Math.pow(10, l / 20)),
    tokenSymbols: seq.map((s) => s.ph),
  };
}

export async function renderDiffSinger(job: RenderJob): Promise<Float32Array> {
  const bank = banks.get(job.voice);
  if (!bank) throw new VoicebankError(`The voicebank for this track is not loaded on this device (${job.voice.replace(/^ds:/, '')}). Import it from the menu.`);
  const ort = await getOrt();
  const { data, acoustic, vocoder } = bank;
  const cfg = data.config;
  // English words missing from the voicebank's dictionary fall back to the CMU dictionary,
  // which the worker loads on first use.
  if (!languageReady(job.language)) await ensureLanguage(job.language);
  const inp = buildAcousticInputs(job, data);
  const n = inp.tokens.length;
  const T = inp.frames;
  const feeds: Record<string, OrtNS.Tensor> = {
    tokens: new ort.Tensor('int64', inp.tokens, [1, n]),
    durations: new ort.Tensor('int64', inp.durations, [1, n]),
    f0: new ort.Tensor('float32', inp.f0, [1, T]),
  };
  const names = new Set(acoustic.inputNames);
  if (names.has('languages')) feeds.languages = new ort.Tensor('int64', inp.languages ?? new BigInt64Array(n), [1, n]);
  if (names.has('speedup')) feeds.speedup = new ort.Tensor('int64', BigInt64Array.from([50n]), [1]);
  if (names.has('steps')) feeds.steps = new ort.Tensor('int64', BigInt64Array.from([20n]), [1]);
  if (names.has('depth')) feeds.depth = new ort.Tensor('float32', Float32Array.from([cfg.max_depth ?? 1]), [1]);
  if (names.has('gender')) feeds.gender = new ort.Tensor('float32', inp.keyShift, [1, T]);
  if (names.has('velocity')) feeds.velocity = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, T]);
  if (names.has('energy')) feeds.energy = new ort.Tensor('float32', inp.energyDb, [1, T]);
  if (names.has('breathiness')) feeds.breathiness = new ort.Tensor('float32', inp.breathinessDb, [1, T]);
  if (names.has('voicing')) feeds.voicing = new ort.Tensor('float32', new Float32Array(T).fill(-12), [1, T]);
  if (names.has('tension')) feeds.tension = new ort.Tensor('float32', inp.tensionLogit, [1, T]);
  if (names.has('spk_embed')) {
    const emb = data.speakerEmbed;
    const hidden = emb?.length ?? cfg.hidden_size ?? 256;
    const tiled = new Float32Array(T * hidden);
    if (emb) for (let k = 0; k < T; k++) tiled.set(emb, k * hidden);
    feeds.spk_embed = new ort.Tensor('float32', tiled, [1, T, hidden]);
  }
  const acOut = await acoustic.run(feeds);
  const mel = acOut.mel ?? acOut[acoustic.outputNames[0]];
  if (!mel || mel.dims.length !== 3) throw new VoicebankError('The acoustic model returned an unexpected output.');
  const vocNames = new Set(vocoder.inputNames);
  const vFeeds: Record<string, OrtNS.Tensor> = {};
  vFeeds[vocNames.has('mel') ? 'mel' : vocoder.inputNames[0]] = mel;
  if (vocNames.has('f0')) vFeeds.f0 = new ort.Tensor('float32', inp.f0.subarray(0, mel.dims[1]), [1, mel.dims[1]]);
  const vOut = await vocoder.run(vFeeds);
  const wave = vOut.waveform ?? vOut[vocoder.outputNames[0]];
  const raw = wave.data as Float32Array;
  const vocSr = data.vocoderConfig.sample_rate ?? inp.sr;

  // Resample to the project rate and fit the phrase length exactly.
  const outLen = Math.round((job.end - job.start) * job.sampleRate);
  const out = new Float32Array(outLen);
  const ratio = vocSr / job.sampleRate;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    if (k + 1 >= raw.length) {
      if (k < raw.length) out[i] = raw[k];
      continue;
    }
    const f = x - k;
    out[i] = raw[k] * (1 - f) + raw[k + 1] * f;
  }
  // Loudness curve as gain (DiffSinger models have no loudness input), plus edge fades.
  const framesPerSample = inp.sr / inp.hop / job.sampleRate;
  for (let i = 0; i < outLen; i++) {
    const fi = Math.min(inp.frames - 1, Math.floor(i * framesPerSample));
    const v = out[i] * inp.loudnessGain[fi];
    out[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  const fade = Math.min(Math.floor(job.sampleRate * 0.005), Math.floor(outLen / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[outLen - 1 - i] *= g;
  }
  return out;
}
