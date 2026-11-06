import type { Language, Project } from '../core/model';
import { ensureLanguage, languageReady } from '../voice/phonemizer';
import { planProject, type RenderJob, type TrackPlan } from './plan';
import type { WorkerIn, WorkerOut } from './worker';
import type { VoiceReply } from './dispatch';

export interface PhraseAudio {
  key: string;
  trackId: string;
  start: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface RenderStatus {
  total: number;
  ready: number;
  errors: string[];
  loadingDictionary: boolean;
}

type Listener = (event: 'ready' | 'removed' | 'status', key?: string) => void;

const RETAIN_UNUSED = 96;

/**
 * Owns rendered phrase audio on the main thread and keeps it in sync with the project.
 * Only phrases whose content hash changed are sent to the worker.
 */
export class RenderManager {
  private worker: Worker | null = null;
  private readonly audio = new Map<string, PhraseAudio>();
  private readonly unused: string[] = [];
  private pending = new Map<string, RenderJob>();
  private readonly errors = new Map<string, string>();
  private plans: TrackPlan[] = [];
  private readonly listeners = new Set<Listener>();
  private loadingDictionary = false;
  private lastProject: Project | null = null;
  private priorityTime = 0;
  private readonly voiceWaiters = new Map<string, (r: VoiceReply) => void>();
  /** Phonemes reported by the renderer, by phrase key then note id. */
  private readonly sungPhonemes = new Map<string, Map<string, string[]>>();

  constructor(private readonly createWorker: () => Worker | null) {}

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = this.createWorker();
    } catch {
      this.worker = null;
    }
    if (this.worker) {
      this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        for (const key of this.pending.keys()) this.errors.set(key, e.message || 'Render worker failed');
        this.pending.clear();
        this.emit('status');
      };
    }
    return this.worker;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: 'ready' | 'removed' | 'status', key?: string): void {
    for (const fn of this.listeners) fn(event, key);
  }

  /** Re-plans the project. Call after every project change (it is cheap). */
  update(project: Project, priorityTime = this.priorityTime): void {
    this.lastProject = project;
    this.priorityTime = priorityTime;
    const langs = new Set<Language>(project.tracks.map((t) => t.language));
    const missing = [...langs].filter((l) => !languageReady(l));
    if (missing.length > 0) {
      if (!this.loadingDictionary) {
        this.loadingDictionary = true;
        this.emit('status');
        Promise.all(missing.map((l) => ensureLanguage(l)))
          .catch((err: unknown) => {
            console.error('Dictionary failed to load; using spelling rules instead.', err);
          })
          .finally(() => {
            this.loadingDictionary = false;
            if (this.lastProject) this.update(this.lastProject);
          });
      }
      // Plan anyway so phonemes display, but only render once the dictionary is ready.
      this.plans = planProject(project);
      this.emit('status');
      return;
    }
    this.plans = planProject(project);
    const wanted = new Map<string, RenderJob>();
    for (const tp of this.plans) for (const job of tp.jobs) wanted.set(job.key, job);

    // Drop audio no longer referenced (keep a few recent ones for undo).
    for (const key of [...this.audio.keys()]) {
      if (!wanted.has(key) && !this.unused.includes(key)) {
        this.unused.push(key);
        this.emit('removed', key);
      }
    }
    const revived: string[] = [];
    for (let i = this.unused.length - 1; i >= 0; i--) {
      if (wanted.has(this.unused[i])) revived.push(...this.unused.splice(i, 1));
    }
    while (this.unused.length > RETAIN_UNUSED) {
      const k = this.unused.shift()!;
      this.audio.delete(k);
      this.sungPhonemes.delete(k);
    }
    for (const key of [...this.errors.keys()]) if (!wanted.has(key)) this.errors.delete(key);

    const todo = [...wanted.values()].filter((j) => !this.audio.has(j.key) && !this.errors.has(j.key));
    // Render what is near the playhead first.
    todo.sort((a, b) => priority(a, priorityTime) - priority(b, priorityTime));
    this.pending = new Map(todo.map((j) => [j.key, j]));
    const worker = this.ensureWorker();
    if (worker) {
      const msg: WorkerIn = { type: 'jobs', jobs: todo };
      worker.postMessage(msg);
    } else {
      void this.renderInline(todo);
    }
    // Previously removed audio that became wanted again (undo) is ready immediately.
    for (const key of revived) if (this.audio.has(key)) this.emit('ready', key);
    this.emit('status');
  }

  private async renderInline(jobs: RenderJob[]): Promise<void> {
    const { renderJob } = await import('./dispatch');
    for (const job of jobs) {
      if (!this.pending.has(job.key)) continue;
      try {
        const { samples, phonemes } = await renderJob(job);
        this.onMessage({ type: 'done', key: job.key, samples, ...(phonemes ? { phonemes } : {}) });
      } catch (err) {
        this.onMessage({ type: 'error', key: job.key, message: err instanceof Error ? err.message : String(err) });
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private onMessage(msg: WorkerOut): void {
    if (msg.type === 'done') {
      const job = this.pending.get(msg.key) ?? this.findJob(msg.key);
      this.pending.delete(msg.key);
      if (!job) return;
      this.audio.set(msg.key, { key: msg.key, trackId: job.trackId, start: job.start, samples: msg.samples, sampleRate: job.sampleRate });
      if (msg.phonemes) this.sungPhonemes.set(msg.key, new Map(Object.entries(msg.phonemes)));
      this.emit('ready', msg.key);
      this.emit('status');
    } else if (msg.type === 'error') {
      this.pending.delete(msg.key);
      this.errors.set(msg.key, msg.message);
      console.error('Render failed:', msg.message);
      this.emit('status');
    } else if (msg.type === 'voice') {
      const w = this.voiceWaiters.get(msg.id);
      if (w) {
        this.voiceWaiters.delete(msg.id);
        w(msg);
      }
    } else if (msg.type === 'idle') {
      this.emit('status');
    }
  }

  private findJob(key: string): RenderJob | undefined {
    for (const tp of this.plans) for (const j of tp.jobs) if (j.key === key) return j;
    return undefined;
  }

  /** Sends voicebank files to the worker. Resolves with the worker's reply. */
  loadVoicebank(id: string, files: Record<string, ArrayBuffer>): Promise<VoiceReply> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve({ type: 'voice', id, ok: false, message: 'Background rendering is not available in this browser.' });
    return new Promise((resolve) => {
      this.voiceWaiters.set(id, resolve);
      worker.postMessage({ type: 'loadVoicebank', id, files } satisfies WorkerIn, Object.values(files));
    });
  }

  /** Sends a vocoder package (.oudep/.zip) to the worker for voicebanks that do not include one. */
  loadVocoder(files: Record<string, ArrayBuffer>): Promise<VoiceReply> {
    const worker = this.ensureWorker();
    const id = `vocoder:${Date.now()}`;
    if (!worker) return Promise.resolve({ type: 'voice', id, ok: false, message: 'Background rendering is not available in this browser.' });
    return new Promise((resolve) => {
      this.voiceWaiters.set(id, resolve);
      worker.postMessage({ type: 'loadVocoder', id, files } satisfies WorkerIn, Object.values(files));
    });
  }

  /** Clears cached audio and errors for a voice (e.g. after loading its voicebank) and re-renders. */
  invalidateVoice(voice: string): void {
    for (const tp of this.plans) {
      for (const j of tp.jobs) {
        if (j.voice === voice) {
          this.audio.delete(j.key);
          this.errors.delete(j.key);
        }
      }
    }
    if (this.lastProject) this.update(this.lastProject);
  }

  status(): RenderStatus {
    let total = 0;
    let ready = 0;
    for (const tp of this.plans) {
      for (const j of tp.jobs) {
        total++;
        if (this.audio.has(j.key)) ready++;
      }
    }
    return { total, ready, errors: [...new Set(this.errors.values())], loadingDictionary: this.loadingDictionary };
  }

  /** Audio for all phrases of the current plan that are ready. */
  phrases(): PhraseAudio[] {
    const out: PhraseAudio[] = [];
    for (const tp of this.plans) for (const j of tp.jobs) {
      const a = this.audio.get(j.key);
      if (a) out.push(a);
    }
    return out;
  }

  phrase(key: string): PhraseAudio | undefined {
    return this.audio.get(key);
  }

  isCurrent(key: string): boolean {
    return this.plans.some((tp) => tp.jobs.some((j) => j.key === key));
  }

  /** Phonemes for a note (from the current plan). */
  phonemes(noteId: string): string[] | undefined {
    for (const tp of this.plans) {
      const p = tp.phonemes.get(noteId);
      if (!p) continue;
      // Neural voices report the voicebank phonemes they actually sang.
      for (const j of tp.jobs) {
        const sung = this.sungPhonemes.get(j.key)?.get(noteId);
        if (sung) return sung;
      }
      return p;
    }
    return undefined;
  }

  /** Whether the phrase containing a note has rendered. */
  noteState(trackId: string, noteId: string): 'ready' | 'pending' | 'error' | 'none' {
    const tp = this.plans.find((p) => p.trackId === trackId);
    if (!tp) return 'none';
    for (const j of tp.jobs) {
      if (j.notes.some((n) => n.id === noteId)) {
        if (this.audio.has(j.key)) return 'ready';
        if (this.errors.has(j.key)) return 'error';
        return 'pending';
      }
    }
    return 'none';
  }

  /** Resolves when every phrase of the current plan has rendered (or failed). */
  whenIdle(timeoutMs = 120000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        const s = this.status();
        if (!s.loadingDictionary && s.ready + this.errorCount() >= s.total) {
          off();
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          off();
          reject(new Error('Rendering timed out'));
        }
      };
      const off = this.on(() => check());
      check();
    });
  }

  private errorCount(): number {
    let n = 0;
    for (const tp of this.plans) for (const j of tp.jobs) if (this.errors.has(j.key) && !this.audio.has(j.key)) n++;
    return n;
  }

  /** Retry phrases that failed. */
  retryErrors(): void {
    this.errors.clear();
    if (this.lastProject) this.update(this.lastProject);
  }
}

function priority(job: RenderJob, t: number): number {
  if (job.end < t) return 1e6 + (t - job.end);
  return Math.max(0, job.start - t);
}
