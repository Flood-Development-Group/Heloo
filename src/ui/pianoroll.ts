import {
  MAX_PITCH,
  MIN_NOTE_TICKS,
  MIN_PITCH,
  clampPitch,
  createNote,
  isBlackKey,
  noteEnd,
  pitchName,
  sortedNotes,
  type Note,
} from '../core/model';
import { PPQ, ticksPerBar, ticksPerBeat } from '../core/time';
import type { RenderManager } from '../engine/client';
import { isConnected, timedNotes } from '../engine/notes';
import { PitchModel } from '../engine/pitch';
import type { Player } from '../audio/player';
import type { Store } from './store';

export const KEYBOARD_W = 56;
export const RULER_H = 30;

export interface RollHooks {
  editLyric(noteId: string): void;
  seek(sec: number): void;
  toast(msg: string): void;
}

type Mode =
  | 'none'
  | 'move'
  | 'resize-l'
  | 'resize-r'
  | 'create'
  | 'marquee'
  | 'erase'
  | 'pan'
  | 'pinch'
  | 'ruler'
  | 'keyboard';

interface PointerInfo {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  type: string;
  time: number;
}

interface DragState {
  mode: Mode;
  downTick: number;
  downPitch: number;
  anchorId: string | null;
  originals: Map<string, { onset: number; duration: number; pitch: number }>;
  moved: boolean;
  lastPreviewPitch: number;
  marquee?: { x0: number; y0: number; x1: number; y1: number; additive: boolean; base: Set<string> };
  pinch?: { cx: number; cy: number; sx: number; sy: number; view: Store['view'] };
  pan?: { x: number; y: number; view: Store['view'] };
}

const COLORS = {
  bg: '#16181d',
  rowWhite: '#1d2027',
  rowBlack: '#181a20',
  rowC: '#2a2e38',
  bar: '#3a3f4c',
  beat: '#2a2e38',
  sub: '#21242c',
  ruler: '#22252d',
  rulerText: '#9aa3b5',
  keyWhite: '#d8dce4',
  keyBlack: '#30343e',
  keyText: '#4a5060',
  playhead: '#ff6b6b',
  loop: 'rgba(79,195,247,0.10)',
  loopBar: '#4fc3f7',
  marquee: 'rgba(120,170,255,0.18)',
  marqueeBorder: 'rgba(120,170,255,0.8)',
  pitchLine: 'rgba(255,255,255,0.7)',
  text: '#0d0f13',
  phoneme: '#8b93a5',
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export class PianoRoll {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  dirty = true;
  private readonly pointers = new Map<number, PointerInfo>();
  private drag: DragState | null = null;
  private lastTap: { time: number; noteId: string | null; x: number; y: number } | null = null;
  private pressedKey: number | null = null;
  private pitchCache: { version: number; trackId: string; model: PitchModel; runs: [number, number][] } | null = null;
  private version = 0;
  private penSeen = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly store: Store,
    private readonly render: RenderManager,
    private readonly player: Player,
    private readonly hooks: RollHooks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'roll-canvas';
    this.canvas.setAttribute('aria-label', 'Piano roll');
    container.appendChild(this.canvas);
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('Canvas 2D is not supported');
    this.g = g;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onCancel(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    store.on((kind) => {
      if (kind === 'project' || kind === 'live') this.version++;
      this.dirty = true;
    });
    render.on(() => {
      this.dirty = true;
    });
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dirty = true;
  }

  get gridWidth(): number {
    return this.w - KEYBOARD_W;
  }

  get gridHeight(): number {
    return this.h - RULER_H;
  }

  // ---- coordinates -------------------------------------------------------

  xOf(tick: number): number {
    const v = this.store.view;
    return KEYBOARD_W + (tick - v.scrollTick) * v.pxPerTick;
  }

  tickAt(x: number): number {
    const v = this.store.view;
    return v.scrollTick + (x - KEYBOARD_W) / v.pxPerTick;
  }

  rowTop(pitch: number): number {
    const v = this.store.view;
    return RULER_H + (v.topPitch - pitch - 1) * v.rowHeight;
  }

  /** Continuous pitch at y, where row centres are integers. */
  pitchAt(y: number): number {
    const v = this.store.view;
    return v.topPitch - (y - RULER_H) / v.rowHeight - 0.5;
  }

  yOfMidi(m: number): number {
    const v = this.store.view;
    return RULER_H + (v.topPitch - m - 0.5) * v.rowHeight;
  }

  /** Scrolls so that a pitch range is centred vertically. */
  centerOnPitch(pitch: number): void {
    const rows = this.gridHeight / this.store.view.rowHeight;
    this.store.setView({ topPitch: pitch + rows / 2 });
  }

  /** Zooms and scrolls to show the start of the current track's notes (up to ~8 bars). */
  fitToNotes(): void {
    const notes = this.store.track?.notes ?? [];
    const bar = ticksPerBar(this.store.project.timeSignature);
    if (notes.length === 0) {
      this.store.setView({ scrollTick: -PPQ / 2, pxPerTick: Math.max(0.08, Math.min(0.3, this.gridWidth / (bar * 2 + PPQ))) });
      this.centerOnPitch(66);
      return;
    }
    const first = Math.min(...notes.map((n) => n.onset));
    const last = Math.max(...notes.map((n) => noteEnd(n)));
    const span = Math.min(last - first, bar * 8);
    const px = Math.max(0.05, Math.min(0.3, this.gridWidth / (span + 2 * PPQ)));
    this.store.setView({ pxPerTick: px, scrollTick: first - PPQ });
    const pitches = notes.map((n) => n.pitch);
    this.centerOnPitch((Math.min(...pitches) + Math.max(...pitches)) / 2);
  }

  visibleTickRange(): [number, number] {
    return [this.tickAt(KEYBOARD_W), this.tickAt(this.w)];
  }

  // ---- hit testing -------------------------------------------------------

  private noteRect(n: Note): { x: number; y: number; w: number; h: number } {
    const x = this.xOf(n.onset);
    const x2 = this.xOf(noteEnd(n));
    const y = this.rowTop(n.pitch);
    return { x, y, w: Math.max(2, x2 - x), h: this.store.view.rowHeight };
  }

  hitNote(x: number, y: number, touch: boolean): { note: Note; zone: 'body' | 'left' | 'right' } | null {
    const t = this.store.track;
    if (!t) return null;
    // Topmost (latest drawn) first; selected notes are drawn last.
    const notes = [...t.notes].sort((a, b) => Number(this.store.selection.has(b.id)) - Number(this.store.selection.has(a.id)));
    const slop = touch ? 6 : 2;
    for (const n of notes) {
      const r = this.noteRect(n);
      if (x >= r.x - slop && x <= r.x + r.w + slop && y >= r.y - 1 && y <= r.y + r.h + 1) {
        const edge = Math.max(6, Math.min(touch ? 18 : 10, r.w / 4));
        if (x >= r.x + r.w - edge) return { note: n, zone: 'right' };
        if (x <= r.x + edge) return { note: n, zone: 'left' };
        return { note: n, zone: 'body' };
      }
    }
    return null;
  }

  // ---- pointer handling --------------------------------------------------

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private touchPointers(): PointerInfo[] {
    return [...this.pointers.values()].filter((p) => p.type === 'touch');
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events may not be capturable
    }
    this.pointers.set(e.pointerId, { id: e.pointerId, x, y, startX: x, startY: y, type: e.pointerType, time: performance.now() });
    if (e.pointerType === 'pen' && !this.penSeen) {
      this.penSeen = true;
      if (!this.store.pencilOnly) {
        this.store.pencilOnly = true;
        this.store.savePrefs();
        this.hooks.toast('Apple Pencil detected: the Pencil edits, one finger scrolls. Change this in the menu.');
      }
    }
    // Two fingers: pinch/pan, cancelling any edit started by the first finger.
    const touches = this.touchPointers();
    if (touches.length >= 2) {
      if (this.drag && this.drag.mode !== 'pinch' && this.drag.mode !== 'pan') {
        if (this.store.inGesture) this.store.cancelGesture();
        if (this.drag.mode === 'marquee' && this.drag.marquee) this.store.setSelection(this.drag.marquee.base);
      }
      this.startPinch(touches[0], touches[1]);
      return;
    }
    if (this.pointers.size > 1) return;
    this.startSingle(e, x, y);
  }

  private startPinch(a: PointerInfo, b: PointerInfo): void {
    this.drag = {
      mode: 'pinch',
      downTick: 0,
      downPitch: 0,
      anchorId: null,
      originals: new Map(),
      moved: true,
      lastPreviewPitch: -1,
      pinch: {
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        sx: Math.abs(a.x - b.x),
        sy: Math.abs(a.y - b.y),
        view: { ...this.store.view },
      },
    };
  }

  private newDrag(mode: Mode, x: number, y: number): DragState {
    return {
      mode,
      downTick: this.tickAt(x),
      downPitch: this.pitchAt(y),
      anchorId: null,
      originals: new Map(),
      moved: false,
      lastPreviewPitch: -1,
    };
  }

  private startSingle(e: PointerEvent, x: number, y: number): void {
    const store = this.store;
    const touch = e.pointerType === 'touch';
    if (y < RULER_H && x >= KEYBOARD_W) {
      this.drag = this.newDrag('ruler', x, y);
      const tick = Math.max(0, store.snapTick(this.tickAt(x)));
      this.hooks.seek(store.tempo.tickToSec(tick));
      return;
    }
    if (x < KEYBOARD_W) {
      this.drag = this.newDrag('keyboard', x, y);
      this.drag.pan = { x, y, view: { ...store.view } };
      const p = Math.round(this.pitchAt(y));
      if (p >= MIN_PITCH && p <= MAX_PITCH) {
        this.pressedKey = p;
        this.player.preview(p);
      }
      this.dirty = true;
      return;
    }
    if (touch && store.pencilOnly) {
      this.drag = this.newDrag('pan', x, y);
      this.drag.pan = { x, y, view: { ...store.view } };
      return;
    }
    const hit = this.hitNote(x, y, touch || e.pointerType === 'pen');
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (store.tool === 'erase') {
      store.beginGesture('Erase notes');
      this.drag = this.newDrag('erase', x, y);
      if (hit) this.eraseNote(hit.note.id);
      return;
    }
    if (hit) {
      if (!store.selection.has(hit.note.id)) {
        store.setSelection(additive ? [...store.selection, hit.note.id] : [hit.note.id]);
      } else if (additive) {
        const s = new Set(store.selection);
        s.delete(hit.note.id);
        store.setSelection(s);
        this.drag = this.newDrag('none', x, y);
        return;
      }
      const mode: Mode = hit.zone === 'body' ? 'move' : hit.zone === 'left' ? 'resize-l' : 'resize-r';
      this.drag = this.newDrag(mode, x, y);
      this.drag.anchorId = hit.note.id;
      for (const n of store.selectedNotes()) this.drag.originals.set(n.id, { onset: n.onset, duration: n.duration, pitch: n.pitch });
      store.beginGesture(mode === 'move' ? 'Move notes' : 'Resize notes');
      return;
    }
    if (store.tool === 'pen') {
      const pitch = clampPitch(this.pitchAt(y));
      const onset = Math.max(0, store.snapTick(this.tickAt(x), 'floor'));
      const len = this.newNoteLength();
      store.beginGesture('Add note');
      const note = createNote(onset, len, pitch, store.track.language === 'ja' ? 'ら' : 'la');
      store.track.notes.push(note);
      store.setSelection([note.id]);
      this.drag = this.newDrag('create', x, y);
      this.drag.anchorId = note.id;
      this.drag.originals.set(note.id, { onset, duration: len, pitch });
      this.drag.lastPreviewPitch = pitch;
      this.player.preview(pitch);
      store.live();
      return;
    }
    // Select tool on empty space: marquee.
    this.drag = this.newDrag('marquee', x, y);
    const base = additive ? new Set(store.selection) : new Set<string>();
    this.drag.marquee = { x0: x, y0: y, x1: x, y1: y, additive, base };
    if (!additive) store.setSelection([]);
  }

  private onMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const { x, y } = this.local(e);
    p.x = x;
    p.y = y;
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(x - p.startX, y - p.startY) > 4) d.moved = true;
    const store = this.store;
    switch (d.mode) {
      case 'pinch': {
        const ts = this.touchPointers();
        if (ts.length < 2 || !d.pinch) return;
        const [a, b] = ts;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const v0 = d.pinch.view;
        const sx = Math.abs(a.x - b.x);
        const sy = Math.abs(a.y - b.y);
        const px = d.pinch.sx > 40 ? v0.pxPerTick * (sx / d.pinch.sx) : v0.pxPerTick;
        const row = d.pinch.sy > 40 ? v0.rowHeight * (sy / d.pinch.sy) : v0.rowHeight;
        const tick0 = v0.scrollTick + (d.pinch.cx - KEYBOARD_W) / v0.pxPerTick;
        const pitch0 = v0.topPitch - (d.pinch.cy - RULER_H) / v0.rowHeight;
        const pxC = Math.min(2, Math.max(0.02, px));
        const rowC = Math.min(48, Math.max(8, row));
        store.setView({
          pxPerTick: pxC,
          rowHeight: rowC,
          scrollTick: tick0 - (cx - KEYBOARD_W) / pxC,
          topPitch: pitch0 + (cy - RULER_H) / rowC,
        });
        return;
      }
      case 'pan':
      case 'keyboard': {
        if (!d.pan) return;
        const v0 = d.pan.view;
        if (d.mode === 'keyboard') {
          if (!d.moved) return;
          this.pressedKey = null;
          store.setView({ topPitch: v0.topPitch + (y - d.pan.y) / v0.rowHeight });
        } else {
          store.setView({
            scrollTick: v0.scrollTick - (x - d.pan.x) / v0.pxPerTick,
            topPitch: v0.topPitch + (y - d.pan.y) / v0.rowHeight,
          });
        }
        return;
      }
      case 'ruler': {
        const tick = Math.max(0, store.snapTick(this.tickAt(x)));
        if (store.loop.enabled && d.moved) {
          const a = Math.max(0, store.snapTick(d.downTick));
          const lo = Math.min(a, tick);
          const hi = Math.max(a, tick);
          if (hi - lo >= (store.snap || PPQ / 4)) {
            store.loop.start = lo;
            store.loop.end = hi;
            store.emit('transport');
          }
        } else {
          this.hooks.seek(store.tempo.tickToSec(tick));
        }
        return;
      }
      case 'marquee': {
        const m = d.marquee!;
        m.x1 = x;
        m.y1 = y;
        const x0 = Math.min(m.x0, m.x1);
        const x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1);
        const y1 = Math.max(m.y0, m.y1);
        const sel = new Set(m.base);
        for (const n of store.track.notes) {
          const r = this.noteRect(n);
          if (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0) sel.add(n.id);
        }
        store.setSelection(sel);
        this.dirty = true;
        return;
      }
      case 'erase': {
        const hit = this.hitNote(x, y, e.pointerType !== 'mouse');
        if (hit) this.eraseNote(hit.note.id);
        return;
      }
      case 'move': {
        if (!d.moved) return;
        const rawDelta = this.tickAt(x) - d.downTick;
        const dt = store.snap > 0 ? Math.round(rawDelta / store.snap) * store.snap : Math.round(rawDelta);
        const dp = Math.round(this.pitchAt(y) - d.downPitch);
        let minOnset = Infinity;
        let minP = Infinity;
        let maxP = -Infinity;
        for (const o of d.originals.values()) {
          minOnset = Math.min(minOnset, o.onset);
          minP = Math.min(minP, o.pitch);
          maxP = Math.max(maxP, o.pitch);
        }
        const dtC = Math.max(-minOnset, dt);
        const dpC = Math.min(MAX_PITCH - maxP, Math.max(MIN_PITCH - minP, dp));
        for (const n of store.track.notes) {
          const o = d.originals.get(n.id);
          if (!o) continue;
          n.onset = o.onset + dtC;
          n.pitch = o.pitch + dpC;
        }
        const anchor = d.anchorId ? d.originals.get(d.anchorId) : undefined;
        if (anchor && anchor.pitch + dpC !== d.lastPreviewPitch) {
          d.lastPreviewPitch = anchor.pitch + dpC;
          this.player.preview(d.lastPreviewPitch, 0.15);
        }
        store.live();
        return;
      }
      case 'resize-r':
      case 'create': {
        const anchor = d.anchorId ? d.originals.get(d.anchorId) : undefined;
        if (!anchor) return;
        const minLen = this.minLength();
        const endTick = store.snap > 0 ? Math.round(this.tickAt(x) / store.snap) * store.snap : Math.round(this.tickAt(x));
        const delta = endTick - (anchor.onset + anchor.duration);
        for (const n of store.track.notes) {
          const o = d.originals.get(n.id);
          if (!o) continue;
          n.duration = Math.max(minLen, o.duration + delta);
        }
        if (d.mode === 'create') {
          // Dragging vertically while creating also sets the pitch.
          const n = store.track.notes.find((nn) => nn.id === d.anchorId);
          if (n) {
            const p = clampPitch(this.pitchAt(y));
            if (p !== n.pitch) {
              n.pitch = p;
              this.player.preview(p, 0.15);
            }
            if (!d.moved) n.duration = anchor.duration;
          }
        }
        store.live();
        return;
      }
      case 'resize-l': {
        const anchor = d.anchorId ? d.originals.get(d.anchorId) : undefined;
        if (!anchor) return;
        const minLen = this.minLength();
        const startTick = store.snap > 0 ? Math.round(this.tickAt(x) / store.snap) * store.snap : Math.round(this.tickAt(x));
        const delta = startTick - anchor.onset;
        for (const n of store.track.notes) {
          const o = d.originals.get(n.id);
          if (!o) continue;
          const end = o.onset + o.duration;
          const onset = Math.max(0, Math.min(end - minLen, o.onset + delta));
          n.onset = onset;
          n.duration = end - onset;
        }
        store.live();
        return;
      }
      default:
        return;
    }
  }

  /** New notes are a quarter note long (or one snap unit when the snap is longer). */
  private newNoteLength(): number {
    return Math.max(PPQ, this.store.snap);
  }

  private minLength(): number {
    const s = this.store.snap;
    return s > 0 ? Math.min(s, PPQ) : MIN_NOTE_TICKS;
  }

  private eraseNote(id: string): void {
    const t = this.store.track;
    const i = t.notes.findIndex((n) => n.id === id);
    if (i >= 0) {
      t.notes.splice(i, 1);
      this.store.selection.delete(id);
      this.store.live();
    }
  }

  private onUp(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'pinch') {
      if (this.pointers.size === 0) this.drag = null;
      else {
        // Lifting one finger of a pinch: continue panning with nothing until all lift.
        const remaining = [...this.pointers.values()];
        if (remaining.length < 2) this.drag = { ...d, mode: 'none' };
      }
      return;
    }
    if (this.pointers.size > 0) return;
    this.drag = null;
    this.pressedKey = null;
    const store = this.store;
    if (store.inGesture) store.endGesture();
    if (d.mode === 'marquee' && d.marquee) this.dirty = true;
    // Tap handling: double tap edits lyrics (or creates a note on empty space).
    if (p && !d.moved && (d.mode === 'move' || d.mode === 'marquee' || d.mode === 'resize-l' || d.mode === 'resize-r' || d.mode === 'none')) {
      const now = performance.now();
      const noteId = d.anchorId;
      const last = this.lastTap;
      if (last && now - last.time < 380 && Math.hypot(last.x - p.x, last.y - p.y) < 24 && last.noteId === noteId) {
        this.lastTap = null;
        if (noteId) this.hooks.editLyric(noteId);
        else if (store.tool === 'select') this.createAt(p.x, p.y);
        return;
      }
      this.lastTap = { time: now, noteId, x: p.x, y: p.y };
    } else {
      this.lastTap = null;
    }
    this.dirty = true;
  }

  private createAt(x: number, y: number): void {
    const store = this.store;
    const pitch = clampPitch(this.pitchAt(y));
    const onset = Math.max(0, store.snapTick(this.tickAt(x), 'floor'));
    const len = this.newNoteLength();
    const note = createNote(onset, len, pitch, store.track.language === 'ja' ? 'ら' : 'la');
    store.mutate('Add note', () => {
      store.track.notes.push(note);
    });
    store.setSelection([note.id]);
    this.player.preview(pitch);
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (this.store.inGesture) this.store.cancelGesture();
      this.drag = null;
      this.pressedKey = null;
      this.dirty = true;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    const v = this.store.view;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch (ctrlKey) or Cmd+scroll: zoom horizontally around the cursor.
      const factor = Math.exp(-dy * 0.01);
      const tick = this.tickAt(x);
      const px = Math.min(2, Math.max(0.02, v.pxPerTick * factor));
      this.store.setView({ pxPerTick: px, scrollTick: tick - (x - KEYBOARD_W) / px });
      return;
    }
    if (e.altKey) {
      const factor = Math.exp(-dy * 0.01);
      const pitch = this.pitchAt(y);
      const row = Math.min(48, Math.max(8, v.rowHeight * factor));
      this.store.setView({ rowHeight: row, topPitch: pitch + 0.5 + (y - RULER_H) / row });
      return;
    }
    if (e.shiftKey && dx === 0) {
      this.store.setView({ scrollTick: v.scrollTick + dy / v.pxPerTick });
      return;
    }
    this.store.setView({ scrollTick: v.scrollTick + dx / v.pxPerTick, topPitch: v.topPitch - dy / v.rowHeight });
  }

  // ---- drawing -----------------------------------------------------------

  private pitchData(): { model: PitchModel; runs: [number, number][] } | null {
    const t = this.store.track;
    if (!t || t.notes.length === 0) return null;
    if (this.pitchCache && this.pitchCache.version === this.version && this.pitchCache.trackId === t.id) return this.pitchCache;
    const notes = timedNotes(t, this.store.tempo);
    const model = new PitchModel(notes, { pitchBend: t.params.pitchBend, vibratoEnv: t.params.vibratoEnv }, this.store.tempo);
    const runs: [number, number][] = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const last = runs[runs.length - 1];
      if (last && i > 0 && isConnected(notes[i - 1], n)) last[1] = n.end;
      else runs.push([n.start, n.end]);
    }
    this.pitchCache = { version: this.version, trackId: t.id, model, runs };
    return this.pitchCache;
  }

  draw(playheadSec: number): void {
    const g = this.g;
    const { w, h } = this;
    const v = this.store.view;
    const store = this.store;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, w, h);

    // Rows.
    const pTop = Math.ceil(v.topPitch);
    const pBottom = Math.floor(v.topPitch - (h - RULER_H) / v.rowHeight) - 1;
    g.save();
    g.beginPath();
    g.rect(KEYBOARD_W, RULER_H, w - KEYBOARD_W, h - RULER_H);
    g.clip();
    for (let p = pTop; p >= pBottom; p--) {
      const y = this.rowTop(p);
      g.fillStyle = isBlackKey(p) ? COLORS.rowBlack : COLORS.rowWhite;
      g.fillRect(KEYBOARD_W, y, w, v.rowHeight);
      if (((p % 12) + 12) % 12 === 0) {
        g.fillStyle = COLORS.rowC;
        g.fillRect(KEYBOARD_W, y + v.rowHeight - 1, w, 1);
      }
    }
    // Vertical grid.
    const ts = store.project.timeSignature;
    const bar = ticksPerBar(ts);
    const beat = ticksPerBeat(ts);
    const [t0, t1] = this.visibleTickRange();
    const sub = store.snap > 0 ? store.snap : beat / 4;
    const drawLines = (step: number, color: string) => {
      if (step * v.pxPerTick < 6) return;
      g.fillStyle = color;
      for (let t = Math.floor(Math.max(0, t0) / step) * step; t <= t1; t += step) {
        g.fillRect(Math.round(this.xOf(t)), RULER_H, 1, h);
      }
    };
    drawLines(sub, COLORS.sub);
    drawLines(beat, COLORS.beat);
    drawLines(bar, COLORS.bar);
    if (store.loop.enabled) {
      g.fillStyle = COLORS.loop;
      g.fillRect(this.xOf(store.loop.start), RULER_H, (store.loop.end - store.loop.start) * v.pxPerTick, h);
    }

    // Other tracks (ghost notes).
    for (const t of store.project.tracks) {
      if (t.id === store.selectedTrackId) continue;
      g.fillStyle = t.color;
      g.globalAlpha = 0.18;
      for (const n of t.notes) {
        if (noteEnd(n) < t0 || n.onset > t1) continue;
        const r = this.noteRect(n);
        roundRect(g, r.x, r.y + 2, r.w, r.h - 4, 3);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    // Current track notes.
    const track = store.track;
    if (track) {
      const sorted = sortedNotes(track.notes);
      const overlapping = new Set<string>();
      for (let i = 0; i + 1 < sorted.length; i++) if (noteEnd(sorted[i]) > sorted[i + 1].onset) overlapping.add(sorted[i].id);
      const ordered = [...sorted].sort((a, b) => Number(store.selection.has(a.id)) - Number(store.selection.has(b.id)));
      g.font = `600 ${Math.min(14, Math.max(10, v.rowHeight * 0.55))}px -apple-system, system-ui, sans-serif`;
      g.textBaseline = 'middle';
      for (const n of ordered) {
        if (noteEnd(n) < t0 || n.onset > t1) continue;
        const r = this.noteRect(n);
        if (r.y > h || r.y + r.h < RULER_H) continue;
        const selected = store.selection.has(n.id);
        const state = this.render.noteState(track.id, n.id);
        g.globalAlpha = state === 'pending' ? 0.65 : 1;
        g.fillStyle = selected ? '#ffffff' : track.color;
        roundRect(g, r.x + 0.5, r.y + 1.5, r.w - 1, r.h - 3, 4);
        g.fill();
        g.globalAlpha = 1;
        if (state === 'error') {
          g.strokeStyle = '#ff5252';
          g.lineWidth = 2;
          g.stroke();
        } else if (selected) {
          g.strokeStyle = track.color;
          g.lineWidth = 2;
          g.stroke();
        }
        if (overlapping.has(n.id)) {
          g.fillStyle = '#ff5252';
          g.fillRect(r.x + r.w - 3, r.y + 2, 2, r.h - 4);
        }
        if (r.w > 14 && v.rowHeight >= 10) {
          g.save();
          g.beginPath();
          g.rect(r.x + 4, r.y, r.w - 8, r.h);
          g.clip();
          g.fillStyle = COLORS.text;
          g.fillText(n.lyric || '·', r.x + 6, r.y + r.h / 2 + 0.5);
          g.restore();
        }
        if (v.rowHeight >= 14 && r.w > 18) {
          const ph = this.render.phonemes(n.id);
          if (ph && ph.length) {
            g.save();
            g.beginPath();
            g.rect(r.x, r.y + r.h, r.w - 2, 14);
            g.clip();
            g.font = '500 10px -apple-system, system-ui, sans-serif';
            g.fillStyle = COLORS.phoneme;
            g.fillText(ph.join(' ').toLowerCase(), r.x + 4, r.y + r.h + 7);
            g.restore();
            g.font = `600 ${Math.min(14, Math.max(10, v.rowHeight * 0.55))}px -apple-system, system-ui, sans-serif`;
          }
        }
      }

      // Pitch curve.
      const pd = this.pitchData();
      if (pd) {
        g.strokeStyle = COLORS.pitchLine;
        g.lineWidth = 1.5;
        const secL = store.tempo.tickToSec(t0);
        const secR = store.tempo.tickToSec(t1);
        const step = Math.max(0.004, (secR - secL) / Math.max(1, (w - KEYBOARD_W) / 3));
        for (const [a, b] of pd.runs) {
          const s0 = Math.max(a, secL);
          const s1 = Math.min(b, secR);
          if (s1 <= s0) continue;
          const n = Math.ceil((s1 - s0) / step) + 1;
          const out = new Float64Array(n);
          pd.model.fill(s0, (s1 - s0) / Math.max(1, n - 1), out);
          g.beginPath();
          for (let k = 0; k < n; k++) {
            const sec = s0 + ((s1 - s0) * k) / Math.max(1, n - 1);
            const px = this.xOf(store.tempo.secToTick(sec));
            const py = this.yOfMidi(out[k]);
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
          }
          g.stroke();
        }
      }
    }

    // Marquee.
    const m = this.drag?.marquee;
    if (this.drag?.mode === 'marquee' && m) {
      const x0 = Math.min(m.x0, m.x1);
      const y0 = Math.min(m.y0, m.y1);
      g.fillStyle = COLORS.marquee;
      g.strokeStyle = COLORS.marqueeBorder;
      g.lineWidth = 1;
      g.fillRect(x0, y0, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      g.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }
    g.restore();

    this.drawRuler(t0, t1, bar, beat);
    this.drawKeyboard(pTop, pBottom);

    // Playhead.
    const px = this.xOf(store.tempo.secToTick(playheadSec));
    if (px >= KEYBOARD_W && px <= w) {
      g.fillStyle = COLORS.playhead;
      g.fillRect(Math.round(px) - 1, RULER_H, 2, h - RULER_H);
      g.beginPath();
      g.moveTo(px - 6, RULER_H - 10);
      g.lineTo(px + 6, RULER_H - 10);
      g.lineTo(px, RULER_H);
      g.closePath();
      g.fill();
    }
    this.dirty = false;
  }

  private drawRuler(t0: number, t1: number, bar: number, beat: number): void {
    const g = this.g;
    const store = this.store;
    const v = store.view;
    g.fillStyle = COLORS.ruler;
    g.fillRect(KEYBOARD_W, 0, this.w - KEYBOARD_W, RULER_H);
    g.fillStyle = COLORS.bar;
    g.fillRect(KEYBOARD_W, RULER_H - 1, this.w - KEYBOARD_W, 1);
    g.save();
    g.beginPath();
    g.rect(KEYBOARD_W, 0, this.w - KEYBOARD_W, RULER_H);
    g.clip();
    if (store.loop.enabled) {
      g.fillStyle = COLORS.loopBar;
      g.globalAlpha = 0.6;
      g.fillRect(this.xOf(store.loop.start), 0, (store.loop.end - store.loop.start) * v.pxPerTick, 5);
      g.globalAlpha = 1;
    }
    g.font = '600 11px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = COLORS.rulerText;
    // Label every bar, or every Nth bar when zoomed out.
    const barPx = bar * v.pxPerTick;
    const every = barPx >= 40 ? 1 : barPx >= 20 ? 2 : barPx >= 10 ? 4 : 8;
    for (let b = Math.max(0, Math.floor(t0 / bar)); b * bar <= t1; b++) {
      const x = this.xOf(b * bar);
      g.fillRect(Math.round(x), RULER_H - 10, 1, 10);
      if (b % every === 0) g.fillText(String(b + 1), x + 4, RULER_H / 2 + 2);
      if (beat * v.pxPerTick >= 8) {
        for (let k = 1; k < bar / beat; k++) g.fillRect(Math.round(this.xOf(b * bar + k * beat)), RULER_H - 5, 1, 5);
      }
    }
    // Tempo markers.
    g.fillStyle = '#ffd54f';
    for (const m of store.project.tempos) {
      if (m.tick < t0 - PPQ * 8 || m.tick > t1) continue;
      if (m.tick === 0 && store.project.tempos.length === 1) continue;
      g.fillText(`♩${Math.round(m.bpm * 10) / 10}`, this.xOf(m.tick) + 4, 8);
    }
    g.restore();
  }

  private drawKeyboard(pTop: number, pBottom: number): void {
    const g = this.g;
    const v = this.store.view;
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, KEYBOARD_W, this.h - RULER_H);
    g.clip();
    g.fillStyle = COLORS.keyWhite;
    g.fillRect(0, RULER_H, KEYBOARD_W, this.h - RULER_H);
    g.font = '600 10px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let p = pTop; p >= pBottom; p--) {
      const y = this.rowTop(p);
      if (isBlackKey(p)) {
        g.fillStyle = COLORS.keyBlack;
        g.fillRect(0, y, KEYBOARD_W * 0.62, v.rowHeight);
      } else {
        g.fillStyle = '#b9bfcb';
        g.fillRect(0, y + v.rowHeight - 0.5, KEYBOARD_W, 0.5);
      }
      if (this.pressedKey === p) {
        g.fillStyle = 'rgba(79,195,247,0.6)';
        g.fillRect(0, y, KEYBOARD_W, v.rowHeight);
      }
      if (((p % 12) + 12) % 12 === 0 && v.rowHeight >= 9) {
        g.fillStyle = COLORS.keyText;
        g.fillText(pitchName(p), KEYBOARD_W - 26, y + v.rowHeight / 2);
      }
    }
    g.restore();
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, 0, KEYBOARD_W, RULER_H);
    g.fillStyle = '#000';
    g.fillRect(KEYBOARD_W - 1, RULER_H, 1, this.h - RULER_H);
  }

  /** Rectangle (CSS px, relative to the canvas) of a note, for positioning the lyric editor. */
  noteBox(noteId: string): { x: number; y: number; w: number; h: number } | null {
    const n = this.store.track?.notes.find((nn) => nn.id === noteId);
    return n ? this.noteRect(n) : null;
  }

  /** Scrolls horizontally so the note is visible. */
  reveal(noteId: string): void {
    const n = this.store.track?.notes.find((nn) => nn.id === noteId);
    if (!n) return;
    const [t0, t1] = this.visibleTickRange();
    const v = this.store.view;
    let scrollTick = v.scrollTick;
    if (n.onset < t0 || noteEnd(n) > t1) scrollTick = n.onset - (t1 - t0) * 0.3;
    let topPitch = v.topPitch;
    const rows = this.gridHeight / v.rowHeight;
    if (n.pitch > v.topPitch - 1 || n.pitch < v.topPitch - rows) topPitch = n.pitch + rows / 2;
    if (scrollTick !== v.scrollTick || topPitch !== v.topPitch) this.store.setView({ scrollTick, topPitch });
  }

  /** Keeps the playhead in view while playing (page-turn style). */
  follow(playheadSec: number): void {
    const tick = this.store.tempo.secToTick(playheadSec);
    const [t0, t1] = this.visibleTickRange();
    const span = t1 - t0;
    if (tick > t0 + span * 0.92 || tick < t0) this.store.setView({ scrollTick: tick - span * 0.08 });
  }
}
