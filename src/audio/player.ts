import type { PhraseAudio } from '../engine/client';

interface TrackMix {
  gain: number;
  pan: number;
}

interface TrackNodes {
  gain: GainNode;
  pan: StereoPannerNode;
}

type AudioContextCtor = typeof AudioContext;

/** Plays rendered phrases with Web Audio, keeping a sample-accurate clock. */
export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly trackNodes = new Map<string, TrackNodes>();
  private readonly mix = new Map<string, TrackMix>();
  private readonly sources = new Map<string, AudioBufferSourceNode>();
  private readonly buffers = new WeakMap<Float32Array, AudioBuffer>();
  private startCtxTime = 0;
  private startSec = 0;
  private pausedAt = 0;
  playing = false;

  /** Must be called from a user gesture on iOS. */
  ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    // Play through the silent switch on iOS (Safari 16.4+).
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    try {
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch {
      // not supported
    }
    try {
      this.ctx = new Ctor({ sampleRate: 44100, latencyHint: 'interactive' });
    } catch {
      this.ctx = new Ctor();
    }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    void this.ctx.resume();
    return this.ctx;
  }

  get time(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return this.startSec + (this.ctx.currentTime - this.startCtxTime);
  }

  seek(sec: number): void {
    this.pausedAt = Math.max(0, sec);
  }

  setTrackMix(trackId: string, gain: number, pan: number): void {
    this.mix.set(trackId, { gain, pan });
    const nodes = this.trackNodes.get(trackId);
    if (nodes && this.ctx) {
      nodes.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
      nodes.pan.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.01);
    }
  }

  private nodesFor(trackId: string): TrackNodes {
    let nodes = this.trackNodes.get(trackId);
    if (!nodes && this.ctx && this.master) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const m = this.mix.get(trackId) ?? { gain: 1, pan: 0 };
      gain.gain.value = m.gain;
      pan.pan.value = m.pan;
      gain.connect(pan).connect(this.master);
      nodes = { gain, pan };
      this.trackNodes.set(trackId, nodes);
    }
    return nodes!;
  }

  private bufferFor(p: PhraseAudio): AudioBuffer {
    let b = this.buffers.get(p.samples);
    if (!b) {
      b = this.ctx!.createBuffer(1, Math.max(1, p.samples.length), p.sampleRate);
      b.copyToChannel(p.samples as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(p.samples, b);
    }
    return b;
  }

  play(fromSec: number, phrases: readonly PhraseAudio[]): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.stopSources();
    this.startSec = Math.max(0, fromSec);
    // Small lead time so the first phrase starts cleanly.
    this.startCtxTime = ctx.currentTime + 0.05;
    this.playing = true;
    for (const p of phrases) this.schedule(p);
  }

  /** Schedules a phrase if it is still (partly) ahead of the playhead. */
  schedule(p: PhraseAudio): void {
    if (!this.playing || !this.ctx || this.sources.has(p.key)) return;
    const duration = p.samples.length / p.sampleRate;
    const now = this.time;
    if (p.start + duration <= now) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.bufferFor(p);
    src.connect(this.nodesFor(p.trackId).gain);
    const when = this.startCtxTime + (p.start - this.startSec);
    if (when >= this.ctx.currentTime) src.start(when);
    else src.start(this.ctx.currentTime, Math.min(duration, this.ctx.currentTime - when));
    src.onended = () => {
      if (this.sources.get(p.key) === src) this.sources.delete(p.key);
    };
    this.sources.set(p.key, src);
  }

  /** Stops a phrase that was replaced by an edit. */
  unschedule(key: string): void {
    const src = this.sources.get(key);
    if (!src) return;
    try {
      src.stop();
    } catch {
      // already stopped
    }
    this.sources.delete(key);
  }

  stop(): void {
    this.pausedAt = this.time;
    this.playing = false;
    this.stopSources();
  }

  private stopSources(): void {
    for (const src of this.sources.values()) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
  }

  /** Short sine-ish tone for auditioning note pitches. */
  preview(midi: number, seconds = 0.25): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }
}

/** Equal-power pan gains, matching StereoPannerNode for mono input. */
export function panGains(pan: number): [number, number] {
  const x = (Math.max(-1, Math.min(1, pan)) + 1) / 2;
  return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
}

export interface MixTrack {
  trackId: string;
  gain: number;
  pan: number;
}

/** Mixes phrases to stereo for export. */
export function mixdown(phrases: readonly PhraseAudio[], tracks: readonly MixTrack[], sampleRate: number, tailSec = 0.5): [Float32Array, Float32Array] {
  const byTrack = new Map(tracks.map((t) => [t.trackId, t]));
  let end = 0;
  for (const p of phrases) {
    if (!byTrack.has(p.trackId)) continue;
    end = Math.max(end, p.start + p.samples.length / p.sampleRate);
  }
  const frames = Math.ceil((end + tailSec) * sampleRate);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (const p of phrases) {
    const t = byTrack.get(p.trackId);
    if (!t || t.gain === 0) continue;
    const [gl, gr] = panGains(t.pan);
    const off = Math.round(p.start * sampleRate);
    for (let i = 0; i < p.samples.length; i++) {
      const j = off + i;
      if (j < 0 || j >= frames) continue;
      const v = p.samples[i] * t.gain;
      L[j] += v * gl;
      R[j] += v * gr;
    }
  }
  return [L, R];
}
