/** Encodes PCM audio as a RIFF/WAVE file. Samples are clamped to [-1, 1]. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, bitDepth: 16 | 24 = 16): ArrayBuffer {
  if (channels.length === 0) throw new Error('encodeWav needs at least one channel');
  const numCh = channels.length;
  const frames = channels[0].length;
  for (const c of channels) if (c.length !== frames) throw new Error('All channels must have the same length');
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  const max = bitDepth === 16 ? 0x7fff : 0x7fffff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      if (!Number.isFinite(s)) s = 0;
      s = Math.max(-1, Math.min(1, s));
      const q = Math.round(s * max);
      if (bitDepth === 16) {
        v.setInt16(off, q, true);
        off += 2;
      } else {
        v.setUint8(off, q & 0xff);
        v.setUint8(off + 1, (q >> 8) & 0xff);
        v.setUint8(off + 2, (q >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return buf;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
  bitDepth: number;
}

/** Minimal PCM WAV decoder (16/24-bit integer, 32-bit float). Used by tests and for importing reference audio. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const v = new DataView(buffer);
  const str = (off: number, n: number) => String.fromCharCode(...new Uint8Array(buffer, off, n));
  if (buffer.byteLength < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buffer.byteLength) {
    const id = str(off, 4);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk');
      const bps = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, buffer.byteLength - body) / (bps * fmt.channels));
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          let s: number;
          if (fmt.format === 3 && fmt.bits === 32) s = v.getFloat32(p, true);
          else if (fmt.bits === 16) s = v.getInt16(p, true) / 0x8000;
          else if (fmt.bits === 24) {
            let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
            if (x & 0x800000) x -= 0x1000000;
            s = x / 0x800000;
          } else throw new Error(`Unsupported WAV bit depth ${fmt.bits}`);
          chans[c][i] = s;
          p += bps;
        }
      }
      return { sampleRate: fmt.rate, channels: chans, bitDepth: fmt.bits };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV file has no data chunk');
}
