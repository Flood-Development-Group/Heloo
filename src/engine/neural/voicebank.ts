import { unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';
import type { Language } from '../../core/model';
import { isVowel as builtinIsVowel, isSonorant as builtinIsSonorant } from '../../voice/phonemes';
import { phonemizeLyric, type LyricResult } from '../../voice/phonemizer';
import type { Phonology } from '../timing';

/**
 * Reads DiffSinger-format voicebanks (the layout used by OpenUtau): a dsconfig.yaml with
 * an acoustic ONNX model and phoneme list, an optional dsdict*.yaml dictionary, and a
 * vocoder (vocoder.yaml + ONNX) either inside the zip or supplied separately.
 */

export interface AcousticConfig {
  phonemes: string;
  acoustic: string;
  vocoder?: string;
  speakers?: string[];
  hidden_size?: number;
  use_lang_id?: boolean;
  languages?: string;
  use_key_shift_embed?: boolean;
  use_speed_embed?: boolean;
  use_energy_embed?: boolean;
  use_breathiness_embed?: boolean;
  use_voicing_embed?: boolean;
  use_tension_embed?: boolean;
  use_variable_depth?: boolean;
  max_depth?: number;
  sample_rate?: number;
  hop_size?: number;
  num_mel_bins?: number;
  augmentation_args?: { random_pitch_shifting?: { range?: [number, number] } };
}

export interface VocoderConfig {
  name?: string;
  model: string;
  sample_rate?: number;
  hop_size?: number;
  num_mel_bins?: number;
}

export interface DictData {
  entries: Map<string, string[]>;
  types: Map<string, string>;
}

export interface VoicebankData {
  name: string;
  /** Directory (inside the zip) holding dsconfig.yaml. */
  root: string;
  config: AcousticConfig;
  phonemes: Map<string, number>;
  languages: Map<string, number> | null;
  dicts: Map<string, DictData>;
  acousticModel: Uint8Array;
  vocoderConfig: VocoderConfig;
  vocoderModel: Uint8Array;
  speakerEmbed: Float32Array | null;
  /** Optional variance model (dsvariance) that predicts energy/breathiness/voicing/tension curves. */
  variance: VarianceData | null;
  warnings: string[];
}

export interface VarianceData {
  linguisticModel: Uint8Array;
  varianceModel: Uint8Array;
  phonemes: Map<string, number>;
  languages: Map<string, number> | null;
}

export class VoicebankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoicebankError';
  }
}

/** Thrown when a voicebank is fine but no vocoder is available for it. */
export class VocoderMissingError extends VoicebankError {
  constructor(
    message: string,
    readonly vocoderName: string | null,
  ) {
    super(message);
    this.name = 'VocoderMissingError';
  }
}

type Files = Record<string, Uint8Array>;

const text = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

/** Resolves a path relative to a directory, normalising "." and "..". */
export function joinPath(dir: string, rel: string): string {
  const parts = (dir + rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function findFile(files: Files, path: string): Uint8Array | undefined {
  if (files[path]) return files[path];
  const lower = path.toLowerCase();
  const key = Object.keys(files).find((k) => k.toLowerCase() === lower);
  return key ? files[key] : undefined;
}

function yamlFile<T>(files: Files, path: string): T {
  const b = findFile(files, path);
  if (!b) throw new VoicebankError(`Missing file in voicebank: ${path}`);
  try {
    return parseYaml(text(b)) as T;
  } catch (err) {
    throw new VoicebankError(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Unzips and normalises paths (forward slashes, no leading "./", macOS metadata removed). */
export function unzipVoicebank(zip: Uint8Array): Files {
  // .oudep vocoder packages are zip files too.
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zip, { filter: (f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('/') && !/(^|\/)\.DS_Store$/.test(f.name) });
  } catch (err) {
    throw new VoicebankError(`This is not a valid zip file (${err instanceof Error ? err.message : String(err)}).`);
  }
  const files: Files = {};
  for (const [name, data] of Object.entries(raw)) files[name.replace(/\\/g, '/').replace(/^\.\//, '')] = data;
  return files;
}

export function parseVocoderYaml(b: Uint8Array): VocoderConfig {
  let cfg: unknown;
  try {
    cfg = parseYaml(text(b).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new VoicebankError(`Could not read vocoder.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }
  const c = cfg as VocoderConfig | null;
  if (!c || typeof c.model !== 'string') throw new VoicebankError('vocoder.yaml does not name a model file.');
  return c;
}

function parsePhonemes(b: Uint8Array, path: string): Map<string, number> {
  const s = text(b);
  const map = new Map<string, number>();
  if (path.toLowerCase().endsWith('.json')) {
    const obj = JSON.parse(s) as Record<string, number>;
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') map.set(k, v);
  } else {
    s.split(/\r?\n/).forEach((line, i) => {
      const p = line.trim();
      if (p && !map.has(p)) map.set(p, i);
    });
  }
  if (map.size === 0) throw new VoicebankError(`The phoneme list ${path} is empty.`);
  return map;
}

function parseYamlDict(files: Files, path: string): DictData {
  const raw = yamlFile<{ entries?: { grapheme?: unknown; phonemes?: unknown }[]; symbols?: { symbol?: unknown; type?: unknown }[] }>(files, path) ?? {};
  const entries = new Map<string, string[]>();
  for (const e of raw.entries ?? []) {
    if (typeof e?.grapheme !== 'string' || !Array.isArray(e.phonemes)) continue;
    entries.set(e.grapheme.toLowerCase(), e.phonemes.map(String));
  }
  const types = new Map<string, string>();
  for (const s of raw.symbols ?? []) if (typeof s?.symbol === 'string' && typeof s.type === 'string') types.set(s.symbol, s.type);
  return { entries, types };
}

/** Plain-text dictionary (dsdict.txt / dictionary.txt): "grapheme<TAB>ph1 ph2" per line. */
function parseTextDict(b: Uint8Array): DictData {
  const entries = new Map<string, string[]>();
  for (const line of text(b).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const tab = t.indexOf('\t');
    const [g, rest] = tab >= 0 ? [t.slice(0, tab), t.slice(tab + 1)] : [t.split(/\s+/)[0], t.split(/\s+/).slice(1).join(' ')];
    const phs = rest.trim().split(/\s+/).filter(Boolean);
    if (g && phs.length) entries.set(g.toLowerCase(), phs);
  }
  return { entries, types: new Map() };
}

/**
 * When a dictionary has no symbol types, infer vowels: syllable dictionaries (pinyin, kana) end
 * every entry with its vowel, so the last phoneme of each entry is a vowel and the rest are not.
 */
function inferTypes(d: DictData): void {
  if (d.types.size > 0) return;
  const last = new Set<string>();
  const other = new Set<string>();
  for (const phs of d.entries.values()) {
    phs.forEach((p, i) => (i === phs.length - 1 ? last : other).add(p));
  }
  for (const p of last) d.types.set(p, 'vowel');
  for (const p of other) if (!last.has(p)) d.types.set(p, 'consonant');
}

/**
 * Parses a voicebank. `extra` can hold a separately supplied vocoder package (vocoder.yaml + .onnx).
 */
export function readVoicebank(files: Files, extra: Files = {}): VoicebankData {
  const all: Files = { ...extra, ...files };
  const configs = Object.keys(all).filter((k) => /(^|\/)dsconfig\.yaml$/i.test(k));
  // The acoustic config is the one that names an acoustic model; prefer the shallowest.
  const candidates = configs
    .map((path) => ({ path, cfg: yamlFile<AcousticConfig>(all, path) }))
    .filter((c) => c.cfg && typeof c.cfg.acoustic === 'string' && typeof c.cfg.phonemes === 'string')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const chosen = candidates[0];
  if (!chosen) {
    throw new VoicebankError(
      'No DiffSinger acoustic model found. The zip must contain a dsconfig.yaml with "acoustic" and "phonemes" entries (OpenUtau DiffSinger format).',
    );
  }
  const root = dirname(chosen.path);
  const cfg = chosen.cfg;
  const warnings: string[] = [];

  const phPath = joinPath(root, cfg.phonemes);
  const phBytes = findFile(all, phPath);
  if (!phBytes) throw new VoicebankError(`Missing phoneme list: ${phPath}`);
  const phonemes = parsePhonemes(phBytes, phPath);

  const acPath = joinPath(root, cfg.acoustic);
  const acousticModel = findFile(all, acPath);
  if (!acousticModel) throw new VoicebankError(`Missing acoustic model: ${acPath}`);

  let languages: Map<string, number> | null = null;
  if (cfg.use_lang_id && cfg.languages) {
    const lb = findFile(all, joinPath(root, cfg.languages));
    if (lb) {
      const obj = JSON.parse(text(lb)) as Record<string, number>;
      languages = new Map(Object.entries(obj).filter(([, v]) => typeof v === 'number'));
    } else warnings.push(`Language list ${cfg.languages} is missing; language ids are set to 0.`);
  }

  // Dictionaries, by language key ("" = default). Preference: dsdict(-lang).yaml next to the
  // acoustic config, then plain-text dsdict.txt / dictionary.txt, then the dsdict.yaml files of
  // the voicebank's dsdur/dspitch/dsvariance folders. Symbol types are merged from all YAML dicts.
  const dicts = new Map<string, DictData>();
  const inRoot = (path: string) => path.startsWith(root) && !path.slice(root.length).includes('/');
  const underRoot = (path: string) => path.startsWith(root);
  const yamlDicts = Object.keys(all)
    .map((path) => ({ path, m: /(^|\/)dsdict(?:-([a-z]{2,3}))?\.yaml$/i.exec(path) }))
    .filter((x) => x.m && underRoot(x.path))
    .sort((a, b) => Number(inRoot(b.path)) - Number(inRoot(a.path)) || a.path.length - b.path.length);
  const allTypes = new Map<string, string>();
  for (const { path, m } of yamlDicts) {
    const d = parseYamlDict(all, path);
    for (const [k, v] of d.types) if (!allTypes.has(k)) allTypes.set(k, v);
    const key = (m![2] ?? '').toLowerCase();
    if (inRoot(path) && !dicts.has(key)) dicts.set(key, d);
  }
  if (!dicts.has('')) {
    const txtPath = Object.keys(all).find((k) => inRoot(k) && /(^|\/)(dsdict|dictionary)\.txt$/i.test(k));
    if (txtPath) dicts.set('', parseTextDict(all[txtPath]));
    else if (yamlDicts.length > 0) dicts.set('', parseYamlDict(all, yamlDicts[0].path));
  }
  for (const d of dicts.values()) {
    for (const [k, v] of allTypes) if (!d.types.has(k)) d.types.set(k, v);
    inferTypes(d);
  }
  if (dicts.size === 0) warnings.push('No dictionary (dsdict.yaml or dsdict.txt) found: lyrics are converted with the built-in dictionary, which may not match this voicebank’s phonemes. Phoneme overrides always work.');

  // Vocoder: a vocoder.yaml in the voicebank or in a separately imported vocoder package.
  // Prefer the one named by dsconfig, then any whose audio format matches the acoustic model.
  const vocoders: { vc: VocoderConfig; model: Uint8Array; score: number }[] = [];
  for (const vp of Object.keys(all).filter((k) => /(^|\/)vocoder\.yaml$/i.test(k))) {
    const vc = yamlFile<VocoderConfig>(all, vp);
    if (!vc || typeof vc.model !== 'string') continue;
    const model = findFile(all, joinPath(dirname(vp), vc.model));
    if (!model) continue;
    const sameFormat =
      (vc.sample_rate ?? 44100) === (cfg.sample_rate ?? 44100) && (vc.hop_size ?? 512) === (cfg.hop_size ?? 512) && (vc.num_mel_bins ?? 128) === (cfg.num_mel_bins ?? 128);
    vocoders.push({ vc, model, score: (vc.name === cfg.vocoder ? 2 : 0) + (sameFormat ? 1 : 0) + (underRoot(vp) ? 0.5 : 0) });
  }
  vocoders.sort((a, b) => b.score - a.score);
  const best = vocoders[0];
  if (!best) {
    throw new VocoderMissingError(
      `This voicebank needs a vocoder${cfg.vocoder ? ` (“${cfg.vocoder}”)` : ''}. Import a vocoder package (.oudep or .zip with vocoder.yaml and its .onnx) and try again.`,
      cfg.vocoder ?? null,
    );
  }
  const vocoderConfig = best.vc;
  const vocoderModel = best.model;
  if (cfg.vocoder && vocoderConfig.name && vocoderConfig.name !== cfg.vocoder) {
    warnings.push(`Using vocoder “${vocoderConfig.name}” instead of “${cfg.vocoder}” (same audio format).`);
  }
  const sr = cfg.sample_rate ?? 44100;
  const hop = cfg.hop_size ?? 512;
  if ((vocoderConfig.sample_rate ?? 44100) !== sr || (vocoderConfig.hop_size ?? 512) !== hop) {
    warnings.push(`The vocoder (${vocoderConfig.sample_rate ?? 44100} Hz, hop ${vocoderConfig.hop_size ?? 512}) does not match the acoustic model (${sr} Hz, hop ${hop}); output may sound wrong.`);
  }

  let speakerEmbed: Float32Array | null = null;
  if (cfg.speakers && cfg.speakers.length > 0) {
    const name = cfg.speakers[0];
    const eb = findFile(all, joinPath(root, `${name}.emb`));
    if (eb) {
      const copy = eb.slice();
      speakerEmbed = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
      if (cfg.speakers.length > 1) warnings.push(`Using speaker “${name}” (the first of ${cfg.speakers.length}).`);
    } else warnings.push(`Speaker embedding ${name}.emb is missing.`);
  }

  // Name: character.yaml "name", else character.txt "name=", else the folder name.
  let name = root.replace(/\/$/, '').split('/').pop() || 'Voicebank';
  const charYaml = findFile(all, joinPath(root, 'character.yaml'));
  const charTxt = findFile(all, joinPath(root, 'character.txt'));
  let named = false;
  if (charYaml) {
    try {
      const c = parseYaml(text(charYaml).replace(/^\uFEFF/, '')) as { name?: unknown };
      if (typeof c?.name === 'string' && c.name.trim()) {
        name = c.name.trim();
        named = true;
      }
    } catch {
      // fall through
    }
  }
  if (!named && charTxt) {
    const m = /^\s*name\s*=\s*(.+)$/m.exec(text(charTxt).replace(/^\uFEFF/, ''));
    if (m) name = m[1].trim();
  }

  // Variance model: a dsconfig.yaml under the voicebank naming "linguistic" and "variance" models.
  let variance: VarianceData | null = null;
  for (const path of configs) {
    if (!path.startsWith(root) || path === chosen.path) continue;
    const vc = yamlFile<{ linguistic?: unknown; variance?: unknown; phonemes?: unknown; use_lang_id?: unknown; languages?: unknown }>(all, path);
    if (!vc || typeof vc.linguistic !== 'string' || typeof vc.variance !== 'string' || typeof vc.phonemes !== 'string') continue;
    const dir = dirname(path);
    const ling = findFile(all, joinPath(dir, vc.linguistic));
    const vari = findFile(all, joinPath(dir, vc.variance));
    const phb = findFile(all, joinPath(dir, vc.phonemes));
    if (!ling || !vari || !phb) {
      warnings.push(`The variance model in ${dir || 'the voicebank'} is incomplete and is not used.`);
      continue;
    }
    let vlangs: Map<string, number> | null = null;
    if (vc.use_lang_id === true && typeof vc.languages === 'string') {
      const lb = findFile(all, joinPath(dir, vc.languages));
      if (lb) vlangs = new Map(Object.entries(JSON.parse(text(lb)) as Record<string, number>).filter(([, v]) => typeof v === 'number'));
    }
    variance = { linguisticModel: ling, varianceModel: vari, phonemes: parsePhonemes(phb, joinPath(dir, vc.phonemes)), languages: vlangs };
    break;
  }

  return { name, root, config: cfg, phonemes, languages, dicts, acousticModel, vocoderConfig, vocoderModel, speakerEmbed, variance, warnings };
}

const CONSONANT_DURATION: Record<string, number> = {
  stop: 0.07,
  fricative: 0.1,
  affricate: 0.1,
  nasal: 0.07,
  liquid: 0.06,
  semivowel: 0.05,
  aspirate: 0.07,
};

/** Builds a phonology that maps lyrics onto a voicebank's own phoneme set. */
export function voicebankPhonology(vb: VoicebankData, lang: Language): Phonology {
  const dict = vb.dicts.get(lang) ?? vb.dicts.get('') ?? vb.dicts.values().next().value ?? null;
  const has = (p: string) => vb.phonemes.has(p);
  const resolve = (p: string): string | null => {
    for (const c of [p, p.toLowerCase(), `${lang}/${p}`, `${lang}/${p.toLowerCase()}`]) if (has(c)) return c;
    return null;
  };
  const typeOf = (p: string): string | undefined => {
    const bare = p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
    return dict?.types.get(p) ?? dict?.types.get(bare);
  };
  const isVowel = (p: string) => {
    const t = typeOf(p);
    if (t) return t === 'vowel';
    const bare = p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
    return builtinIsVowel(bare) || builtinIsVowel(bare.toUpperCase()) || /^[aeiouəɛɔæɪʊ]/i.test(bare);
  };
  const isSonorant = (p: string) => {
    const t = typeOf(p);
    if (t) return t === 'vowel' || t === 'nasal' || t === 'liquid' || t === 'semivowel';
    const bare = p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
    return isVowel(p) || builtinIsSonorant(bare.toUpperCase());
  };
  const vowelGuess = ['a', 'aa', 'ah', `${lang}/a`].map(resolve).find((x): x is string => x !== null);
  const defaultVowel = vowelGuess ?? [...vb.phonemes.keys()].find((p) => isVowel(p)) ?? 'SP';
  const breath = has('AP') ? 'AP' : has('br') ? 'br' : 'SP';

  const phonemize = (lyric: string, override: string | undefined): LyricResult => {
    if (override && override.trim()) {
      const phs = override.trim().split(/\s+/).map(resolve).filter((x): x is string => x !== null);
      if (phs.length > 0) return { kind: 'phonemes', phonemes: phs };
    }
    const t = lyric.trim();
    const builtin = phonemizeLyric(t, lang);
    if (builtin.kind !== 'phonemes') return builtin;
    if (t.startsWith('.')) {
      const phs = t.slice(1).trim().split(/\s+/).map(resolve).filter((x): x is string => x !== null);
      return phs.length ? { kind: 'phonemes', phonemes: phs } : { kind: 'sustain' };
    }
    const entry = dict?.entries.get(t.toLowerCase());
    if (entry) {
      const phs = entry.map(resolve).filter((x): x is string => x !== null);
      if (phs.length) return { kind: 'phonemes', phonemes: phs };
    }
    const direct = resolve(t);
    if (direct) return { kind: 'phonemes', phonemes: [direct] };
    // Fall back to the built-in pronunciation, mapped onto the voicebank's symbols.
    const mapped = builtin.phonemes.map((p) => resolve(p === 'NN' ? 'N' : p === 'DX' ? 'r' : p)).filter((x): x is string => x !== null);
    return { kind: 'phonemes', phonemes: mapped.length ? mapped : [defaultVowel] };
  };

  return {
    phonemize,
    isVowel,
    isSonorant,
    duration: (p) => CONSONANT_DURATION[typeOf(p) ?? ''] ?? 0.07,
    breath,
    defaultVowel,
  };
}
