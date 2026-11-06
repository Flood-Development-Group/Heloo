/**
 * Snapshot-based undo history. Each entry is a serialized project plus a label.
 * Projects are small (kilobytes), so full snapshots keep undo simple and exact.
 */
export interface HistoryEntry {
  label: string;
  snapshot: string;
}

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(private readonly limit = 300) {}

  /** Records the state *before* a change. */
  record(label: string, snapshotBefore: string): void {
    this.past.push({ label, snapshot: snapshotBefore });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }

  /** Returns the snapshot to restore, given the current state. */
  undo(current: string): string | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, snapshot: current });
    return entry.snapshot;
  }

  redo(current: string): string | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, snapshot: current });
    return entry.snapshot;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
