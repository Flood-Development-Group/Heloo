/// <reference lib="webworker" />
import type { RenderJob } from './plan';
import { renderJob, handleVoiceMessage, type VoiceMessage } from './dispatch';

export type WorkerIn = { type: 'jobs'; jobs: RenderJob[] } | VoiceMessage;

export type WorkerOut =
  | { type: 'done'; key: string; samples: Float32Array; phonemes?: Record<string, string[]> }
  | { type: 'error'; key: string; message: string }
  | { type: 'idle' }
  | { type: 'voice'; id: string; ok: boolean; message: string; info?: unknown };

const scope = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let queue: RenderJob[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      const { samples, phonemes } = await renderJob(job);
      scope.postMessage({ type: 'done', key: job.key, samples, ...(phonemes ? { phonemes } : {}) }, [samples.buffer]);
    } catch (err) {
      scope.postMessage({ type: 'error', key: job.key, message: err instanceof Error ? err.message : String(err) });
    }
    // Let newer job lists arrive between phrases.
    await new Promise((r) => setTimeout(r, 0));
  }
  running = false;
  scope.postMessage({ type: 'idle' });
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'jobs') {
    queue = msg.jobs.slice();
    void pump();
    return;
  }
  void handleVoiceMessage(msg).then((reply) => scope.postMessage(reply));
};
