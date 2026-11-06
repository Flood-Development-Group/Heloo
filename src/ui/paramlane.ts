import { eraseRange, sampleCurve, writeSegment } from '../core/curves';
import { PARAM_INFO, noteEnd, type CurvePoint } from '../core/model';
import { ticksPerBar, ticksPerBeat } from '../core/time';
import { KEYBOARD_W } from './pianoroll';
import type { Store } from './store';

const LANE_COLORS: Record<string, string> = {
  pitchBend: '#ffd54f',
  loudness: '#81c784',
  breathiness: '#4fc3f7',
  gender: '#f48fb1',
  tension: '#ff8a65',
  vibratoEnv: '#ba68c8',
};

/** Draw/erase editor for the selected parameter curve, aligned with the piano roll. */
export class ParamLane {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  dirty = true;
  private stroke: { last: CurvePoint; erase: boolean; pointerId: number } | null = null;
  private pan: { x: number; scroll: number; pointerId: number } | null = null;
  private readonly active = new Set<number>();

  constructor(
    private readonly container: HTMLElement,
    private readonly store: Store,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lane-canvas';
    this.canvas.setAttribute('aria-label', 'Parameter curve editor');
    container.appendChild(this.canvas);
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('Canvas 2D is not supported');
    this.g = g;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e, true));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = this.store.view;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (d) this.store.setView({ scrollTick: v.scrollTick + d / v.pxPerTick });
    }, { passive: false });
    store.on(() => {
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

  private xOf(tick: number): number {
    const v = this.store.view;
    return KEYBOARD_W + (tick - v.scrollTick) * v.pxPerTick;
  }

  private tickAt(x: number): number {
    const v = this.store.view;
    return v.scrollTick + (x - KEYBOARD_W) / v.pxPerTick;
  }

  private get info() {
    return PARAM_INFO[this.store.paramLane];
  }

  private yOf(value: number): number {
    const { min, max } = this.info;
    const pad = 8;
    return pad + (1 - (value - min) / (max - min)) * (this.h - 2 * pad);
  }

  private valueAt(y: number): number {
    const { min, max } = this.info;
    const pad = 8;
    const u = 1 - (y - pad) / (this.h - 2 * pad);
    return Math.min(max, Math.max(min, min + u * (max - min)));
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.active.add(e.pointerId);
    const { x, y } = this.local(e);
    const fingerScroll = e.pointerType === 'touch' && this.store.pencilOnly;
    if (this.active.size > 1) {
      // Second finger: cancel drawing and pan instead.
      if (this.stroke) {
        this.store.cancelGesture();
        this.stroke = null;
      }
      this.pan = { x, scroll: this.store.view.scrollTick, pointerId: e.pointerId };
      return;
    }
    if (x < KEYBOARD_W || fingerScroll) {
      this.pan = { x, scroll: this.store.view.scrollTick, pointerId: e.pointerId };
      return;
    }
    const erase = this.store.tool === 'erase' || e.button === 2 || e.altKey;
    const tick = Math.round(this.tickAt(x));
    const value = this.valueAt(y);
    this.store.beginGesture(erase ? `Reset ${this.info.label}` : `Draw ${this.info.label}`);
    this.stroke = { last: [tick, value], erase, pointerId: e.pointerId };
    this.apply([tick, value], [tick, value], erase);
  }

  private apply(a: CurvePoint, b: CurvePoint, erase: boolean): void {
    const track = this.store.track;
    const name = this.store.paramLane;
    const info = this.info;
    const pts = track.params[name];
    track.params[name] = erase
      ? eraseRange(pts, a[0], b[0], info.default)
      : writeSegment(pts, a[0] === b[0] ? [a] : [a, b], info.default, info.min, info.max);
    this.store.live();
  }

  private onMove(e: PointerEvent): void {
    if (this.pan && this.pan.pointerId === e.pointerId) {
      const { x } = this.local(e);
      const v = this.store.view;
      this.store.setView({ scrollTick: this.pan.scroll - (x - this.pan.x) / v.pxPerTick });
      return;
    }
    const s = this.stroke;
    if (!s || s.pointerId !== e.pointerId) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length > 0 ? events : [e];
    const r = this.canvas.getBoundingClientRect();
    for (const ev of list) {
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      const pt: CurvePoint = [Math.round(this.tickAt(px)), this.valueAt(py)];
      if (pt[0] === s.last[0] && pt[1] === s.last[1]) continue;
      this.apply(s.last, pt, s.erase);
      s.last = pt;
    }
  }

  private onUp(e: PointerEvent, cancel = false): void {
    this.active.delete(e.pointerId);
    if (this.pan && this.pan.pointerId === e.pointerId) this.pan = null;
    if (this.stroke && this.stroke.pointerId === e.pointerId) {
      this.stroke = null;
      if (cancel) this.store.cancelGesture();
      else this.store.endGesture();
    }
  }

  draw(): void {
    const g = this.g;
    const { w, h } = this;
    const store = this.store;
    const v = store.view;
    const info = this.info;
    const color = LANE_COLORS[store.paramLane] ?? '#fff';
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#121418';
    g.fillRect(0, 0, w, h);
    // Grid.
    const ts = store.project.timeSignature;
    const bar = ticksPerBar(ts);
    const beat = ticksPerBeat(ts);
    const t0 = this.tickAt(KEYBOARD_W);
    const t1 = this.tickAt(w);
    for (const [step, c] of [
      [beat, '#1f2229'],
      [bar, '#2c303a'],
    ] as const) {
      if (step * v.pxPerTick < 6) continue;
      g.fillStyle = c;
      for (let t = Math.floor(Math.max(0, t0) / step) * step; t <= t1; t += step) g.fillRect(Math.round(this.xOf(t)), 0, 1, h);
    }
    // Default line.
    g.fillStyle = '#333845';
    g.fillRect(KEYBOARD_W, Math.round(this.yOf(info.default)), w, 1);
    // Note spans for reference.
    const track = store.track;
    if (track) {
      g.fillStyle = track.color;
      g.globalAlpha = 0.16;
      for (const n of track.notes) {
        if (noteEnd(n) < t0 || n.onset > t1) continue;
        g.fillRect(this.xOf(n.onset), h - 6, Math.max(1, n.duration * v.pxPerTick - 1), 4);
      }
      g.globalAlpha = 1;
      // Curve.
      const pts = track.params[store.paramLane];
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      for (let x = KEYBOARD_W; x <= w; x += 2) {
        const val = sampleCurve(pts, this.tickAt(x), info.default);
        const y = this.yOf(val);
        if (x === KEYBOARD_W) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = color;
      if (v.pxPerTick > 0.15 && pts.length < 400) {
        for (const [tk, val] of pts) {
          const x = this.xOf(tk);
          if (x < KEYBOARD_W || x > w) continue;
          g.fillRect(x - 1.5, this.yOf(val) - 1.5, 3, 3);
        }
      }
    }
    // Label area.
    g.fillStyle = '#1b1e24';
    g.fillRect(0, 0, KEYBOARD_W, h);
    g.fillStyle = '#9aa3b5';
    g.font = '600 10px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'top';
    g.fillText(String(info.max), 6, 4);
    g.textBaseline = 'bottom';
    g.fillText(`${info.min}`, 6, h - 4);
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(info.unit || '', 6, h / 2);
    this.dirty = false;
  }
}
