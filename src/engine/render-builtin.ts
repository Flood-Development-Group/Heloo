import { TempoMap } from '../core/time';
import { computeFrames } from './acoustic';
import { hashToSeed } from './hash';
import { PitchModel } from './pitch';
import type { RenderJob } from './plan';
import { synthesize } from './synth';
import { builtinVoice } from './voices';

/** Frame period of the control parameters, in samples. */
export const HOP = 220;

/** Renders one phrase with the built-in formant voice. Pure and deterministic. */
export function renderBuiltin(job: RenderJob): Float32Array {
  const tempo = new TempoMap(job.tempos);
  const pitch = new PitchModel(job.notes, { pitchBend: job.curves.pitchBend, vibratoEnv: job.curves.vibratoEnv }, tempo);
  const dt = HOP / job.sampleRate;
  const frames = computeFrames({
    segs: job.segs,
    pitch,
    curves: job.curves,
    tempo,
    voice: builtinVoice(job.voice),
    voiceParams: job.voiceParams,
    t0: job.start,
    t1: job.end,
    dt,
  });
  return synthesize(frames, job.sampleRate, hashToSeed(job.key));
}
