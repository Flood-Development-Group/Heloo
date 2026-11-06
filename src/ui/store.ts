import { History } from '../core/history';
import {
  createDemoProject,
  createProject,
  type Note,
  type ParamName,
  type Project,
  type Track,
} from '../core/model';
import { parseProject, serializeProject } from '../core/project-io';
import { PPQ, TempoMap } from '../core/time';

export type Tool = 'select' | 'pen' | 'erase';

export type ChangeKind = 'project' | 'live' | 'selection' | 'view' | 'transport' | 'tool' | 'status';

export interface Viewport {
  /** Tick at the left edge of the grid. */
  scrollTick: number;
  pxPerTick: number;
  /** Pitch (fractional) at the top edge of the grid. */
  topPitch: number;
  rowHeight: number;
}

export const SNAP_OPTIONS: { label: string; ticks: number }[] = [
  { label: '1/1', ticks: PPQ * 4 },
  { label: '1/2', ticks: PPQ * 2 },
  { label: '1/4', ticks: PPQ },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/32', ticks: PPQ / 8 },
  { label: '1/8T', ticks: PPQ / 3 },
  { label: '1/16T', ticks: PPQ / 6 },
  { label: 'Off', ticks: 0 },
];

const AUTOSAVE_KEY = 'heloo.autosave.v1';
const PREFS_KEY = 'heloo.prefs.v1';

interface Prefs {
  snap: number;
  pencilOnly: boolean;
  inspectorOpen: boolean;
  tracksOpen: boolean;
}

function loadPrefs(): Prefs {
  // First launch: open both side panels only when there is room for them next to the grid.
  const wide = typeof window !== 'undefined' ? window.innerWidth : 1400;
  const def: Prefs = { snap: PPQ / 2, pencilOnly: false, inspectorOpen: wide >= 1000, tracksOpen: wide >= 1300 };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      snap: typeof p.snap === 'number' && SNAP_OPTIONS.some((o) => o.ticks === p.snap) ? p.snap : def.snap,
      pencilOnly: typeof p.pencilOnly === 'boolean' ? p.pencilOnly : def.pencilOnly,
      inspectorOpen: typeof p.inspectorOpen === 'boolean' ? p.inspectorOpen : def.inspectorOpen,
      tracksOpen: typeof p.tracksOpen === 'boolean' ? p.tracksOpen : def.tracksOpen,
    };
  } catch {
    return def;
  }
}

/** Central application state with undoable project mutations and change notifications. */
export class Store {
  project: Project;
  tempo: TempoMap;
  readonly history = new History();
  selectedTrackId: string;
  selection = new Set<string>();
  tool: Tool = 'select';
  snap: number;
  pencilOnly: boolean;
  inspectorOpen: boolean;
  tracksOpen: boolean;
  paramLane: ParamName = 'pitchBend';
  loop = { enabled: false, start: 0, end: PPQ * 16 };
  view: Viewport = { scrollTick: -PPQ, pxPerTick: 0.12, topPitch: 84, rowHeight: 22 };
  playhead = 0;
  playing = false;
  /** Set when the last autosave failed (e.g. storage full). */
  autosaveError: string | null = null;
  private gestureSnapshot: string | null = null;
  private gestureLabel = '';
  private readonly listeners = new Set<(kind: ChangeKind) => void>();
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  clipboard: { notes: Omit<Note, 'id'>[] } | null = null;

  constructor(initial?: Project) {
    this.project = initial ?? Store.loadAutosave() ?? createDemoProject();
    this.tempo = new TempoMap(this.project.tempos);
    this.selectedTrackId = this.project.tracks[0]?.id ?? '';
    const prefs = loadPrefs();
    this.snap = prefs.snap;
    this.pencilOnly = prefs.pencilOnly;
    this.inspectorOpen = prefs.inspectorOpen;
    this.tracksOpen = prefs.tracksOpen;
    this.ensureTrack();
  }

  static loadAutosave(): Project | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? parseProject(raw) : null;
    } catch {
      return null;
    }
  }

  savePrefs(): void {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ snap: this.snap, pencilOnly: this.pencilOnly, inspectorOpen: this.inspectorOpen, tracksOpen: this.tracksOpen }),
      );
    } catch {
      // storage unavailable
    }
  }

  on(fn: (kind: ChangeKind) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind: ChangeKind): void {
    for (const fn of this.listeners) fn(kind);
  }

  get track(): Track {
    return this.project.tracks.find((t) => t.id === this.selectedTrackId) ?? this.project.tracks[0];
  }

  private ensureTrack(): void {
    if (!this.project.tracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = this.project.tracks[0]?.id ?? '';
    }
    const ids = new Set(this.track?.notes.map((n) => n.id) ?? []);
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
  }

  private afterProjectChange(): void {
    this.tempo = new TempoMap(this.project.tempos);
    this.ensureTrack();
    this.scheduleAutosave();
  }

  /** Applies an undoable change. Returns false if nothing changed. */
  mutate(label: string, fn: (p: Project) => void): boolean {
    if (this.gestureSnapshot !== null) this.endGesture();
    const before = serializeProject(this.project);
    fn(this.project);
    const after = serializeProject(this.project);
    if (before === after) return false;
    this.history.record(label, before);
    this.afterProjectChange();
    this.emit('project');
    return true;
  }

  /** Starts a continuous edit (drag). Changes are applied live and recorded once on end. */
  beginGesture(label: string): void {
    if (this.gestureSnapshot !== null) this.endGesture();
    this.gestureSnapshot = serializeProject(this.project);
    this.gestureLabel = label;
  }

  get inGesture(): boolean {
    return this.gestureSnapshot !== null;
  }

  /** Call after modifying the project during a gesture. */
  live(): void {
    this.tempo = new TempoMap(this.project.tempos);
    this.emit('live');
  }

  endGesture(): void {
    const before = this.gestureSnapshot;
    this.gestureSnapshot = null;
    if (before === null) return;
    const after = serializeProject(this.project);
    if (before !== after) {
      this.history.record(this.gestureLabel, before);
      this.afterProjectChange();
    }
    this.emit('project');
  }

  cancelGesture(): void {
    const before = this.gestureSnapshot;
    this.gestureSnapshot = null;
    if (before === null) return;
    this.project = parseProject(before);
    this.afterProjectChange();
    this.emit('project');
  }

  private restore(snapshot: string): void {
    this.project = parseProject(snapshot);
    this.afterProjectChange();
    this.emit('project');
    this.emit('selection');
  }

  undo(): void {
    if (this.gestureSnapshot !== null) this.endGesture();
    const s = this.history.undo(serializeProject(this.project));
    if (s) this.restore(s);
  }

  redo(): void {
    if (this.gestureSnapshot !== null) this.endGesture();
    const s = this.history.redo(serializeProject(this.project));
    if (s) this.restore(s);
  }

  /** Replaces the whole project (open/new). Clears undo history. */
  load(project: Project): void {
    this.gestureSnapshot = null;
    this.project = project;
    this.history.clear();
    this.selection.clear();
    this.selectedTrackId = project.tracks[0]?.id ?? '';
    this.afterProjectChange();
    this.emit('project');
    this.emit('selection');
  }

  newProject(): void {
    this.load(createProject());
  }

  selectTrack(id: string): void {
    if (this.selectedTrackId === id) return;
    this.selectedTrackId = id;
    this.selection.clear();
    this.emit('selection');
  }

  setSelection(ids: Iterable<string>): void {
    this.selection = new Set(ids);
    this.emit('selection');
  }

  selectedNotes(): Note[] {
    return this.track ? this.track.notes.filter((n) => this.selection.has(n.id)) : [];
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.emit('tool');
  }

  setView(v: Partial<Viewport>): void {
    const next = { ...this.view, ...v };
    next.pxPerTick = Math.min(2, Math.max(0.02, next.pxPerTick));
    next.rowHeight = Math.min(48, Math.max(8, next.rowHeight));
    next.topPitch = Math.min(110, Math.max(30, next.topPitch));
    next.scrollTick = Math.max(-PPQ * 4, next.scrollTick);
    this.view = next;
    this.emit('view');
  }

  snapTick(tick: number, mode: 'round' | 'floor' = 'round'): number {
    if (this.snap <= 0) return Math.round(tick);
    const f = mode === 'round' ? Math.round : Math.floor;
    return f(tick / this.snap) * this.snap;
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.autosaveNow(), 800);
  }

  autosaveNow(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    try {
      localStorage.setItem(AUTOSAVE_KEY, serializeProject(this.project));
      if (this.autosaveError) {
        this.autosaveError = null;
        this.emit('status');
      }
    } catch (err) {
      this.autosaveError = err instanceof Error ? err.message : 'Storage is unavailable';
      this.emit('status');
    }
  }
}
