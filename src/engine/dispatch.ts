import type { RenderJob } from './plan';
import { renderBuiltin } from './render-builtin';

/**
 * Routes a job to the engine for its voice. Neural voicebanks ("ds:" voices) are loaded on demand,
 * so the ONNX runtime is only downloaded when such a voice is used.
 */
export async function renderJob(job: RenderJob): Promise<Float32Array> {
  if (job.voice.startsWith('ds:')) {
    const ds = await import('./neural/diffsinger');
    return ds.renderDiffSinger(job);
  }
  return renderBuiltin(job);
}

export type VoiceMessage =
  | { type: 'loadVoicebank'; id: string; files: Record<string, ArrayBuffer> }
  | { type: 'unloadVoicebank'; id: string };

export interface VoiceReply {
  type: 'voice';
  id: string;
  ok: boolean;
  message: string;
  info?: unknown;
}

export async function handleVoiceMessage(msg: VoiceMessage): Promise<VoiceReply> {
  try {
    const ds = await import('./neural/diffsinger');
    if (msg.type === 'loadVoicebank') {
      const info = await ds.loadVoicebank(msg.id, msg.files);
      return { type: 'voice', id: msg.id, ok: true, message: 'loaded', info };
    }
    ds.unloadVoicebank(msg.id);
    return { type: 'voice', id: msg.id, ok: true, message: 'unloaded' };
  } catch (err) {
    return { type: 'voice', id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
