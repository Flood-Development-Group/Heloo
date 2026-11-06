import type { RenderJob } from './plan';
import { renderBuiltin } from './render-builtin';

/**
 * Routes a job to the engine for its voice. Neural voicebanks ("ds:" voices) are loaded on demand,
 * so the ONNX runtime is only downloaded when such a voice is used.
 */
export interface RenderResult {
  samples: Float32Array;
  /** Phonemes actually sung per note id, when they differ from the main thread's plan (neural voices). */
  phonemes?: Record<string, string[]>;
}

export async function renderJob(job: RenderJob): Promise<RenderResult> {
  if (job.voice.startsWith('ds:')) {
    const ds = await import('./neural/diffsinger');
    return ds.renderDiffSingerWithInfo(job);
  }
  return { samples: renderBuiltin(job) };
}

export type VoiceMessage =
  | { type: 'loadVoicebank'; id: string; files: Record<string, ArrayBuffer> }
  | { type: 'unloadVoicebank'; id: string }
  | { type: 'loadVocoder'; id: string; files: Record<string, ArrayBuffer> };

export interface VoiceReply {
  type: 'voice';
  id: string;
  ok: boolean;
  message: string;
  info?: unknown;
  /** Set when a voicebank could not load only because no vocoder is available. */
  code?: 'vocoder-missing';
}

export async function handleVoiceMessage(msg: VoiceMessage): Promise<VoiceReply> {
  try {
    const ds = await import('./neural/diffsinger');
    if (msg.type === 'loadVoicebank') {
      const info = await ds.loadVoicebank(msg.id, msg.files);
      return { type: 'voice', id: msg.id, ok: true, message: 'loaded', info };
    }
    if (msg.type === 'loadVocoder') {
      const info = ds.loadVocoderPackage(msg.files);
      return { type: 'voice', id: msg.id, ok: true, message: 'vocoder loaded', info };
    }
    ds.unloadVoicebank(msg.id);
    return { type: 'voice', id: msg.id, ok: true, message: 'unloaded' };
  } catch (err) {
    const missing = err instanceof Error && err.name === 'VocoderMissingError';
    return { type: 'voice', id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err), ...(missing ? { code: 'vocoder-missing' as const } : {}) };
  }
}
