import { sortedNotes } from '../core/model';
import type { PianoRoll } from './pianoroll';
import type { Store } from './store';

/**
 * Inline lyric input placed over a note. Enter/Tab commits and moves to the next note,
 * Shift+Tab to the previous one, Escape cancels.
 */
export class LyricEditor {
  private readonly input: HTMLInputElement;
  private noteId: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
    private readonly roll: PianoRoll,
  ) {
    this.input = document.createElement('input');
    this.input.className = 'lyric-input';
    this.input.type = 'text';
    this.input.autocapitalize = 'off';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Lyric');
    this.input.setAttribute('enterkeyhint', 'next');
    this.input.hidden = true;
    host.appendChild(this.input);
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => {
      if (this.noteId) this.commit(true);
    });
    store.on((k) => {
      if (k === 'view' || k === 'live') this.position();
      if (k === 'project' && this.noteId && !store.track.notes.some((n) => n.id === this.noteId)) this.close();
    });
  }

  get open(): boolean {
    return this.noteId !== null;
  }

  edit(noteId: string): void {
    const note = this.store.track.notes.find((n) => n.id === noteId);
    if (!note) return;
    this.roll.reveal(noteId);
    this.noteId = noteId;
    this.store.setSelection([noteId]);
    this.input.value = note.lyric;
    this.input.hidden = false;
    this.position();
    // Focus synchronously so the on-screen keyboard opens on iPad.
    this.input.focus();
    this.input.select();
  }

  private position(): void {
    if (!this.noteId) return;
    const box = this.roll.noteBox(this.noteId);
    if (!box) return;
    const w = Math.max(90, box.w);
    this.input.style.left = `${Math.round(box.x)}px`;
    this.input.style.top = `${Math.round(box.y - 4)}px`;
    this.input.style.width = `${Math.round(w)}px`;
    this.input.style.height = `${Math.round(Math.max(30, box.h + 8))}px`;
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      // Typing several words moves the rest onto the following notes.
      const next = this.commit(false, e.shiftKey ? -1 : 1);
      if (next) this.edit(next);
      else this.close();
    }
  }

  /** Saves the lyric; returns the id of the adjacent note in `dir`, if any. */
  private commit(closing: boolean, dir: 1 | -1 = 1): string | null {
    const id = this.noteId;
    if (!id) return null;
    const words = this.input.value.trim().split(/\s+/).filter(Boolean);
    const notes = sortedNotes(this.store.track.notes);
    const idx = notes.findIndex((n) => n.id === id);
    if (idx < 0) {
      this.close();
      return null;
    }
    this.store.mutate('Edit lyric', () => {
      const targets = sortedNotes(this.store.track.notes);
      if (words.length <= 1) {
        targets[idx].lyric = words[0] ?? '';
      } else {
        for (let k = 0; k < words.length && idx + k < targets.length; k++) targets[idx + k].lyric = words[k];
      }
    });
    if (closing) {
      this.close();
      return null;
    }
    const step = dir === 1 ? Math.max(1, words.length) : -1;
    return notes[idx + step]?.id ?? null;
  }

  close(): void {
    this.noteId = null;
    this.input.hidden = true;
    this.input.blur();
  }
}
