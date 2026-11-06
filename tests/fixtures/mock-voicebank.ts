/**
 * Builds tiny stand-in ONNX models with the DiffSinger acoustic/vocoder interfaces and packs them
 * into a voicebank zip. They are not neural networks: the "acoustic model" copies f0 into every
 * mel bin and the "vocoder" outputs 0.001·f0 per sample. That is enough to test loading,
 * tokenisation, timing and the ONNX Runtime plumbing without a real voicebank.
 */
import { zipSync, strToU8 } from 'fflate';

// ---- minimal protobuf writer ------------------------------------------------

class Pb {
  private bytes: number[] = [];
  private varint(v: number | bigint): void {
    let x = BigInt(v);
    if (x < 0n) x += 1n << 64n;
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x > 0n) b |= 0x80;
      this.bytes.push(b);
    } while (x > 0n);
  }
  int(field: number, v: number | bigint): this {
    this.varint((field << 3) | 0);
    this.varint(v);
    return this;
  }
  bytesField(field: number, data: Uint8Array | number[]): this {
    this.varint((field << 3) | 2);
    this.varint(data.length);
    for (const b of data) this.bytes.push(b);
    return this;
  }
  str(field: number, s: string): this {
    return this.bytesField(field, strToU8(s));
  }
  msg(field: number, m: Pb): this {
    return this.bytesField(field, m.done());
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const FLOAT = 1;
const INT64 = 7;

type Dim = number | string;

function valueInfo(name: string, elem: number, dims: Dim[]): Pb {
  const shape = new Pb();
  for (const d of dims) shape.msg(1, typeof d === 'number' ? new Pb().int(1, d) : new Pb().str(2, d));
  const tensorType = new Pb().int(1, elem).msg(2, shape);
  return new Pb().str(1, name).msg(2, new Pb().msg(1, tensorType));
}

function tensor(name: string, elem: number, dims: number[], values: number[]): Pb {
  const t = new Pb();
  for (const d of dims) t.int(1, d);
  t.int(2, elem).str(8, name);
  const raw = elem === FLOAT ? new Uint8Array(new Float32Array(values).buffer) : new Uint8Array(new BigInt64Array(values.map((v) => BigInt(v))).buffer);
  t.bytesField(9, raw);
  return t;
}

function node(op: string, inputs: string[], outputs: string[], attrs: Pb[] = []): Pb {
  const n = new Pb();
  for (const i of inputs) n.str(1, i);
  for (const o of outputs) n.str(2, o);
  n.str(3, `${op}_${outputs[0]}`).str(4, op);
  for (const a of attrs) n.msg(5, a);
  return n;
}

function model(nodes: Pb[], inits: Pb[], inputs: Pb[], outputs: Pb[]): Uint8Array {
  const g = new Pb();
  for (const n of nodes) g.msg(1, n);
  g.str(2, 'mock');
  for (const t of inits) g.msg(5, t);
  for (const i of inputs) g.msg(11, i);
  for (const o of outputs) g.msg(12, o);
  return new Pb().int(1, 7).str(2, 'heloo-test').msg(7, g).msg(8, new Pb().str(1, '').int(2, 13)).done();
}

export function mockAcousticModel(bins = 128): Uint8Array {
  return model(
    [
      node('Unsqueeze', ['f0', 'axes2'], ['u']),
      node('Mul', ['u', 'ones'], ['mel']),
    ],
    [tensor('axes2', INT64, [1], [2]), tensor('ones', FLOAT, [1, 1, bins], new Array(bins).fill(1))],
    [
      valueInfo('tokens', INT64, [1, 'n']),
      valueInfo('durations', INT64, [1, 'n']),
      valueInfo('f0', FLOAT, [1, 'T']),
      valueInfo('steps', INT64, [1]),
      valueInfo('depth', FLOAT, [1]),
    ],
    [valueInfo('mel', FLOAT, [1, 'T', bins])],
  );
}

export function mockVocoderModel(hop = 512, bins = 128): Uint8Array {
  const reduceAttrs = [new Pb().str(1, 'axes').int(8, 2).int(20, 7), new Pb().str(1, 'keepdims').int(3, 1).int(20, 2)];
  return model(
    [
      node('ReduceMean', ['mel'], ['m'], reduceAttrs),
      node('Mul', ['m', 'zero'], ['mz']),
      node('Unsqueeze', ['f0', 'axes2'], ['u']),
      node('Add', ['u', 'mz'], ['u2']),
      node('Mul', ['u2', 'onesHop'], ['e']),
      node('Reshape', ['e', 'shape'], ['r']),
      node('Mul', ['r', 'scale'], ['waveform']),
    ],
    [
      tensor('zero', FLOAT, [1], [0]),
      tensor('axes2', INT64, [1], [2]),
      tensor('onesHop', FLOAT, [1, 1, hop], new Array(hop).fill(1)),
      tensor('shape', INT64, [2], [1, -1]),
      tensor('scale', FLOAT, [1], [0.001]),
    ],
    [valueInfo('mel', FLOAT, [1, 'T', bins]), valueInfo('f0', FLOAT, [1, 'T'])],
    [valueInfo('waveform', FLOAT, [1, 'S'])],
  );
}

export interface MockOptions {
  withVocoder?: boolean;
  withDict?: boolean;
}

export function buildMockVoicebankZip(opts: MockOptions = {}): Uint8Array {
  const { withVocoder = true, withDict = true } = opts;
  const phonemes = ['<PAD>', 'SP', 'AP', 'a', 'i', 'u', 'e', 'o', 'k', 's', 't', 'n', 'm', 'r', 'N', 'cl'];
  const files: Record<string, Uint8Array> = {
    'MockSinger/character.yaml': strToU8('name: Mock Singer\n'),
    'MockSinger/dsconfig.yaml': strToU8(
      ['phonemes: dsmain/phonemes.txt', 'acoustic: dsmain/acoustic.onnx', 'vocoder: mock_vocoder', 'use_variable_depth: true', 'max_depth: 0.6', 'sample_rate: 44100', 'hop_size: 512', 'num_mel_bins: 128'].join('\n'),
    ),
    'MockSinger/dsmain/phonemes.txt': strToU8(phonemes.join('\n')),
    'MockSinger/dsmain/acoustic.onnx': mockAcousticModel(),
  };
  if (withDict) {
    files['MockSinger/dsdict.yaml'] = strToU8(
      [
        'symbols:',
        ...['a', 'i', 'u', 'e', 'o'].map((v) => `  - {symbol: ${v}, type: vowel}`),
        '  - {symbol: k, type: stop}',
        '  - {symbol: t, type: stop}',
        '  - {symbol: s, type: fricative}',
        '  - {symbol: n, type: nasal}',
        '  - {symbol: m, type: nasal}',
        '  - {symbol: r, type: liquid}',
        '  - {symbol: N, type: nasal}',
        'entries:',
        '  - {grapheme: か, phonemes: [k, a]}',
        '  - {grapheme: さ, phonemes: [s, a]}',
        '  - {grapheme: ま, phonemes: [m, a]}',
        '  - {grapheme: ka, phonemes: [k, a]}',
        '  - {grapheme: sa, phonemes: [s, a]}',
      ].join('\n'),
    );
  }
  if (withVocoder) {
    files['MockSinger/mock_vocoder/vocoder.yaml'] = strToU8('name: mock_vocoder\nmodel: mock.onnx\nsample_rate: 44100\nhop_size: 512\nnum_mel_bins: 128\n');
    files['MockSinger/mock_vocoder/mock.onnx'] = mockVocoderModel();
  }
  return zipSync(files, { level: 1 });
}
