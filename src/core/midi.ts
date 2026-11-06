import { PPQ, type TempoMarker, type TimeSignature } from './time';

export interface MidiNote {
  onset: number;
  duration: number;
  pitch: number;
  lyric?: string;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
}

export interface MidiSong {
  tempos: TempoMarker[];
  timeSignature: TimeSignature;
  tracks: MidiTrack[];
}

export class MidiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiFormatError';
  }
}

class Reader {
  pos = 0;
  constructor(
    private readonly data: Uint8Array,
    private readonly end = data.length,
  ) {}
  get done(): boolean {
    return this.pos >= this.end;
  }
  u8(): number {
    if (this.pos >= this.end) throw new MidiFormatError('Unexpected end of MIDI data.');
    return this.data[this.pos++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }
  varlen(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new MidiFormatError('Invalid variable-length value.');
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new MidiFormatError('Unexpected end of MIDI data.');
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  ascii(n: number): string {
    return String.fromCharCode(...this.bytes(n));
  }
}

function decodeText(bytes: Uint8Array): string {
  for (const enc of ['utf-8', 'shift_jis']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch {
      // try the next encoding
    }
  }
  return String.fromCharCode(...bytes);
}

interface RawTrack {
  name: string;
  notes: MidiNote[];
  lyrics: { tick: number; text: string }[];
}

export function parseMidi(buffer: ArrayBuffer | Uint8Array): MidiSong {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const r = new Reader(data);
  if (data.length < 14 || r.ascii(4) !== 'MThd') throw new MidiFormatError('This is not a Standard MIDI File.');
  const headerLen = r.u32();
  const headerStart = r.pos;
  r.u16(); // format
  const ntrks = r.u16();
  const division = r.u16();
  if (division & 0x8000) throw new MidiFormatError('SMPTE-timed MIDI files are not supported.');
  if (division === 0) throw new MidiFormatError('Invalid MIDI time division.');
  r.pos = headerStart + headerLen;
  const scale = PPQ / division;

  const tempos: TempoMarker[] = [];
  let timeSignature: TimeSignature = { numerator: 4, denominator: 4 };
  let tsSet = false;
  const raws: RawTrack[] = [];

  for (let t = 0; t < ntrks && !r.done; t++) {
    const id = r.ascii(4);
    const len = r.u32();
    const start = r.pos;
    const end = Math.min(data.length, start + len);
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    const tr = new Reader(data, end);
    tr.pos = start;
    const raw: RawTrack = { name: '', notes: [], lyrics: [] };
    const open = new Map<number, { tick: number; vel: number }[]>();
    let tick = 0;
    let running = 0;
    while (!tr.done) {
      tick += tr.varlen();
      let status = tr.u8();
      if (status < 0x80) {
        if (running === 0) throw new MidiFormatError('Running status without a previous status byte.');
        tr.pos--;
        status = running;
      }
      if (status === 0xff) {
        const type = tr.u8();
        const mlen = tr.varlen();
        const payload = tr.bytes(mlen);
        if (type === 0x51 && mlen === 3) {
          const usPerQ = (payload[0] << 16) | (payload[1] << 8) | payload[2];
          if (usPerQ > 0) tempos.push({ tick: Math.round(tick * scale), bpm: 60_000_000 / usPerQ });
        } else if (type === 0x58 && mlen >= 2 && !tsSet) {
          const den = 2 ** payload[1];
          if (payload[0] > 0 && [1, 2, 4, 8, 16, 32].includes(den)) {
            timeSignature = { numerator: payload[0], denominator: den };
            tsSet = true;
          }
        } else if (type === 0x05 || type === 0x01) {
          const text = decodeText(payload).trim();
          // Type 0x01 (text) is only used as lyrics when no proper lyric events exist; collect both and prefer 0x05.
          if (text && !text.startsWith('@')) raw.lyrics.push({ tick, text: type === 0x05 ? text : `\u0000${text}` });
        } else if (type === 0x03 && !raw.name) {
          raw.name = decodeText(payload).trim();
        } else if (type === 0x2f) {
          break;
        }
        running = 0;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        tr.bytes(tr.varlen());
        running = 0;
        continue;
      }
      if (status >= 0xf0) {
        // System common/real-time messages are not expected in files; skip conservatively.
        running = 0;
        continue;
      }
      running = status;
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (kind === 0x80 || kind === 0x90) {
        const pitch = tr.u8() & 0x7f;
        const vel = tr.u8() & 0x7f;
        const key = channel * 128 + pitch;
        if (kind === 0x90 && vel > 0) {
          const list = open.get(key) ?? [];
          list.push({ tick, vel });
          open.set(key, list);
        } else {
          const list = open.get(key);
          const on = list?.shift();
          if (on && tick > on.tick) {
            raw.notes.push({ onset: on.tick, duration: tick - on.tick, pitch });
          }
        }
      } else if (kind === 0xc0 || kind === 0xd0) {
        tr.u8();
      } else {
        tr.u8();
        tr.u8();
      }
    }
    r.pos = end;
    raws.push(raw);
  }

  const tracks: MidiTrack[] = [];
  for (const raw of raws) {
    if (raw.notes.length === 0) continue;
    raw.notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
    const realLyrics = raw.lyrics.filter((l) => !l.text.startsWith('\u0000'));
    const lyrics = (realLyrics.length > 0 ? realLyrics : raw.lyrics.map((l) => ({ tick: l.tick, text: l.text.slice(1) }))).sort(
      (a, b) => a.tick - b.tick,
    );
    // Assign each lyric to the note starting closest at or after it (within a 1/32 note).
    const tolerance = division / 8;
    let li = 0;
    for (const note of raw.notes) {
      while (li < lyrics.length && lyrics[li].tick < note.onset - tolerance) li++;
      const l = lyrics[li];
      if (l && Math.abs(l.tick - note.onset) <= tolerance) {
        note.lyric = l.text;
        li++;
      }
    }
    tracks.push({
      name: raw.name || `MIDI ${tracks.length + 1}`,
      notes: raw.notes.map((n) => ({
        onset: Math.round(n.onset * scale),
        duration: Math.max(1, Math.round(n.duration * scale)),
        pitch: n.pitch,
        ...(n.lyric !== undefined ? { lyric: n.lyric } : {}),
      })),
    });
  }
  tempos.sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0 || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0]?.bpm ?? 120 });
  return { tempos, timeSignature, tracks };
}

function varlenBytes(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function chunk(id: string, body: number[]): number[] {
  const len = body.length;
  return [...[...id].map((c) => c.charCodeAt(0)), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body];
}

/** Writes a type-1 MIDI file with one MIDI track per song track. Lyrics are stored as UTF-8 lyric events. */
export function writeMidi(song: MidiSong): Uint8Array {
  const enc = new TextEncoder();
  const conductor: { tick: number; bytes: number[] }[] = [];
  const den = Math.round(Math.log2(song.timeSignature.denominator));
  conductor.push({ tick: 0, bytes: [0xff, 0x58, 4, song.timeSignature.numerator, den, 24, 8] });
  for (const t of song.tempos) {
    const us = Math.round(60_000_000 / t.bpm);
    conductor.push({ tick: t.tick, bytes: [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }
  const encodeEvents = (events: { tick: number; order: number; bytes: number[] }[]): number[] => {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const out: number[] = [];
    let last = 0;
    for (const e of events) {
      out.push(...varlenBytes(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    out.push(0, 0xff, 0x2f, 0);
    return out;
  };
  const chunks: number[] = [];
  chunks.push(...chunk('MTrk', encodeEvents(conductor.map((c, i) => ({ ...c, order: i })))));
  for (const track of song.tracks) {
    const events: { tick: number; order: number; bytes: number[] }[] = [];
    const name = Array.from(enc.encode(track.name));
    events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...varlenBytes(name.length), ...name] });
    for (const n of track.notes) {
      const pitch = Math.min(127, Math.max(0, Math.round(n.pitch)));
      if (n.lyric) {
        const text = Array.from(enc.encode(n.lyric));
        events.push({ tick: n.onset, order: 2, bytes: [0xff, 0x05, ...varlenBytes(text.length), ...text] });
      }
      events.push({ tick: n.onset, order: 3, bytes: [0x90, pitch, 100] });
      // Note-offs sort before note-ons at the same tick.
      events.push({ tick: n.onset + Math.max(1, n.duration), order: 1, bytes: [0x80, pitch, 0] });
    }
    chunks.push(...chunk('MTrk', encodeEvents(events)));
  }
  const ntrks = song.tracks.length + 1;
  const header = chunk('MThd', [0, 1, (ntrks >> 8) & 0xff, ntrks & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  return new Uint8Array([...header, ...chunks]);
}
