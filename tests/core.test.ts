import { describe, expect, it } from 'vitest';
import { PPQ, TempoMap, formatBarBeat } from '../src/core/time';
import { eraseRange, sampleCurve, sampleCurveSorted, simplify, writeSegment } from '../src/core/curves';
import { createDemoProject, createNote, createProject, type CurvePoint } from '../src/core/model';
import { ProjectFormatError, parseProject, serializeProject } from '../src/core/project-io';
import { History } from '../src/core/history';
import { parseMidi, writeMidi } from '../src/core/midi';
import { decodeWav, encodeWav } from '../src/core/wav';

describe('TempoMap', () => {
  it('converts ticks to seconds at a constant tempo', () => {
    const m = new TempoMap([{ tick: 0, bpm: 120 }]);
    expect(m.tickToSec(PPQ)).toBeCloseTo(0.5, 12);
    expect(m.secToTick(1)).toBeCloseTo(2 * PPQ, 9);
    expect(m.tickToSec(-PPQ)).toBeCloseTo(-0.5, 12);
  });

  it('handles tempo changes and round-trips', () => {
    const m = new TempoMap([
      { tick: 0, bpm: 120 },
      { tick: 4 * PPQ, bpm: 60 },
      { tick: 8 * PPQ, bpm: 240 },
    ]);
    expect(m.tickToSec(4 * PPQ)).toBeCloseTo(2, 12);
    expect(m.tickToSec(5 * PPQ)).toBeCloseTo(3, 12);
    expect(m.tickToSec(8 * PPQ)).toBeCloseTo(6, 12);
    expect(m.tickToSec(9 * PPQ)).toBeCloseTo(6.25, 12);
    for (const t of [0, 100, 1919, 1920, 2500, 3840, 5000, 10000]) {
      expect(m.secToTick(m.tickToSec(t))).toBeCloseTo(t, 6);
    }
    expect(m.bpmAt(4 * PPQ - 1)).toBe(120);
    expect(m.bpmAt(4 * PPQ)).toBe(60);
  });

  it('inserts a tick-0 marker and ignores invalid markers', () => {
    const m = new TempoMap([{ tick: 960, bpm: 90 }, { tick: 10, bpm: -5 }, { tick: NaN, bpm: 100 }]);
    expect(m.list).toEqual([
      { tick: 0, bpm: 90 },
      { tick: 960, bpm: 90 },
    ]);
  });

  it('formats bar.beat', () => {
    expect(formatBarBeat(0, { numerator: 4, denominator: 4 })).toBe('1.1');
    expect(formatBarBeat(PPQ * 5, { numerator: 4, denominator: 4 })).toBe('2.2');
    expect(formatBarBeat(PPQ * 3, { numerator: 3, denominator: 4 })).toBe('2.1');
  });
});

describe('curves', () => {
  it('samples with linear interpolation and default outside', () => {
    const pts: CurvePoint[] = [
      [100, 0],
      [200, 10],
    ];
    expect(sampleCurve(pts, 50, 5)).toBe(5);
    expect(sampleCurve(pts, 100, 5)).toBe(0);
    expect(sampleCurve(pts, 150, 5)).toBe(5);
    expect(sampleCurve(pts, 200, 5)).toBe(10);
    expect(sampleCurve(pts, 201, 5)).toBe(5);
    const out = new Float64Array(5);
    sampleCurveSorted(pts, [0, 100, 150, 200, 300], 5, out);
    expect(Array.from(out)).toEqual([5, 0, 5, 10, 5]);
  });

  it('writing a segment leaves the curve outside it unchanged', () => {
    let pts: CurvePoint[] = [];
    pts = writeSegment(pts, [
      [0, 1],
      [1000, 1],
    ], 0);
    pts = writeSegment(pts, [
      [400, 5],
      [600, 5],
    ], 0);
    expect(sampleCurve(pts, 200, 0)).toBe(1);
    expect(sampleCurve(pts, 500, 0)).toBe(5);
    expect(sampleCurve(pts, 800, 0)).toBe(1);
    expect(sampleCurve(pts, 1000, 0)).toBe(1);
    expect(sampleCurve(pts, 1100, 0)).toBe(0);
  });

  it('works when drawing right to left and clamps values', () => {
    const pts = writeSegment([], [
      [500, 3],
      [100, -9],
    ], 0, -1, 1);
    expect(sampleCurve(pts, 100, 0)).toBe(-1);
    expect(sampleCurve(pts, 500, 0)).toBe(1);
  });

  it('erasing resets to default and simplifies away redundant points', () => {
    let pts = writeSegment([], [
      [0, 2],
      [100, 2],
    ], 0);
    pts = eraseRange(pts, -10, 200, 0);
    expect(pts).toEqual([]);
    expect(simplify([[0, 1], [10, 1], [20, 1]], 0)).toEqual([[0, 1], [20, 1]]);
  });
});

describe('project io', () => {
  it('round-trips a project', () => {
    const p = createDemoProject();
    const back = parseProject(serializeProject(p));
    expect(back).toEqual(p);
  });

  it('rejects non-projects with a readable error', () => {
    expect(() => parseProject('nope')).toThrow(ProjectFormatError);
    expect(() => parseProject('{"format":"other"}')).toThrow(/not a Heloo project/);
    expect(() => parseProject('{"format":"heloo-project","version":99}')).toThrow(/Unsupported/);
  });

  it('repairs invalid data and rescales other PPQ values', () => {
    const p = createProject();
    const raw = JSON.parse(serializeProject(p));
    raw.ppq = 960;
    raw.tracks[0].notes = [
      { id: 'a', onset: 960, duration: 960, pitch: 60, lyric: 'la' },
      { id: 'a', onset: 1920, duration: 480, pitch: 500, lyric: 'x' },
      { onset: 'bad' },
    ];
    raw.tracks[0].gainDb = 1000;
    const back = parseProject(JSON.stringify(raw));
    expect(back.tracks[0].notes).toHaveLength(2);
    expect(back.tracks[0].notes[0].onset).toBe(480);
    expect(back.tracks[0].notes[0].duration).toBe(480);
    expect(back.tracks[0].notes[1].pitch).toBe(108);
    expect(back.tracks[0].notes[0].id).not.toBe(back.tracks[0].notes[1].id);
    expect(back.tracks[0].gainDb).toBe(12);
  });
});

describe('History', () => {
  it('undoes and redoes snapshots in order', () => {
    const h = new History();
    h.record('a', 'S0');
    h.record('b', 'S1');
    expect(h.undo('S2')).toBe('S1');
    expect(h.undo('S1')).toBe('S0');
    expect(h.undo('S0')).toBeNull();
    expect(h.redo('S0')).toBe('S1');
    expect(h.redo('S1')).toBe('S2');
    expect(h.canRedo).toBe(false);
    h.undo('S2');
    h.record('c', 'S1');
    expect(h.canRedo).toBe(false);
  });
});

describe('MIDI', () => {
  it('round-trips notes, tempo, time signature and unicode lyrics', () => {
    const bytes = writeMidi({
      tempos: [
        { tick: 0, bpm: 100 },
        { tick: 1920, bpm: 150 },
      ],
      timeSignature: { numerator: 3, denominator: 4 },
      tracks: [
        {
          name: 'Vocal',
          notes: [
            { onset: 0, duration: 480, pitch: 60, lyric: 'hel' },
            { onset: 480, duration: 480, pitch: 62, lyric: 'lo' },
            { onset: 960, duration: 960, pitch: 64, lyric: 'さ' },
          ],
        },
      ],
    });
    const song = parseMidi(bytes);
    expect(song.timeSignature).toEqual({ numerator: 3, denominator: 4 });
    expect(song.tempos[0].bpm).toBeCloseTo(100, 3);
    expect(song.tempos[1].tick).toBe(1920);
    expect(song.tempos[1].bpm).toBeCloseTo(150, 3);
    expect(song.tracks).toHaveLength(1);
    expect(song.tracks[0].name).toBe('Vocal');
    expect(song.tracks[0].notes).toEqual([
      { onset: 0, duration: 480, pitch: 60, lyric: 'hel' },
      { onset: 480, duration: 480, pitch: 62, lyric: 'lo' },
      { onset: 960, duration: 960, pitch: 64, lyric: 'さ' },
    ]);
  });

  it('parses running status and note-on velocity 0 as note-off, rescaling PPQ', () => {
    // Format 0, 1 track, 96 ticks per quarter.
    const trk = [0x00, 0x90, 60, 100, 0x60, 60, 0, 0x00, 62, 100, 0x60, 0x80, 62, 0, 0x00, 0xff, 0x2f, 0x00];
    const bytes = new Uint8Array([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length],
      ...trk,
    ]);
    const song = parseMidi(bytes);
    expect(song.tracks[0].notes).toEqual([
      { onset: 0, duration: 480, pitch: 60 },
      { onset: 480, duration: 480, pitch: 62 },
    ]);
  });

  it('rejects non-MIDI data', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3]))).toThrow(/Standard MIDI/);
  });
});

describe('WAV', () => {
  it('encodes and decodes 16-bit and 24-bit audio', () => {
    const a = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
    const b = new Float32Array([0.25, -0.25, 0, 0, 0, NaN]);
    for (const bits of [16, 24] as const) {
      const wav = encodeWav([a, b], 44100, bits);
      expect(wav.byteLength).toBe(44 + 6 * 2 * (bits / 8));
      const d = decodeWav(wav);
      expect(d.sampleRate).toBe(44100);
      expect(d.channels).toHaveLength(2);
      const tol = bits === 16 ? 1e-4 : 1e-6;
      expect(Math.abs(d.channels[0][1] - 0.5)).toBeLessThan(tol);
      expect(Math.abs(d.channels[0][5] - 1)).toBeLessThan(tol); // clamped
      expect(d.channels[1][5]).toBe(0); // NaN -> 0
    }
  });
});

describe('createNote', () => {
  it('creates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createNote(0, 1, 60, 'la').id));
    expect(ids.size).toBe(1000);
  });
});
