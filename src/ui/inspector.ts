import { DEFAULT_VOICE_PARAMS, clampPitch, pitchName, type Note, type Track, type VoiceParams } from '../core/model';
import { PPQ, clampBpm, formatBarBeat } from '../core/time';
import type { RenderManager } from '../engine/client';
import { BUILTIN_VOICES, isBuiltinVoice } from '../engine/voices';
import { h } from './dom';
import type { Store } from './store';

export interface VoiceOption {
  id: string;
  name: string;
}

interface Binding {
  update(): void;
}

export interface InspectorHooks {
  voices(): VoiceOption[];
  importVoicebank(): void;
  editLyrics(): void;
}

/** Right-hand panel: note, track and project properties. */
export class Inspector {
  readonly el: HTMLElement;
  private readonly noteSection: HTMLElement;
  private readonly bindings: Binding[] = [];
  private readonly noteBindings: Binding[] = [];
  private voiceSelect!: HTMLSelectElement;
  private voiceWarning!: HTMLElement;

  constructor(
    private readonly store: Store,
    private readonly render: RenderManager,
    private readonly hooks: InspectorHooks,
  ) {
    this.el = h('aside', { class: 'inspector', 'aria-label': 'Inspector' });
    this.noteSection = h('section', { class: 'insp-section' });
    this.el.append(this.noteSection, this.buildTrackSection(), this.buildProjectSection());
    this.buildNoteSection();
    store.on((kind) => {
      if (kind === 'live') return;
      if (kind === 'project' || kind === 'selection' || kind === 'status') this.update();
    });
    render.on((ev) => {
      if (ev === 'status') this.updateNoteInfo();
    });
    this.update();
  }

  // ---- helpers -----------------------------------------------------------

  private slider(
    label: string,
    opts: { min: number; max: number; step: number; format: (v: number) => string },
    get: () => number | null,
    set: (v: number) => void,
    list: Binding[],
    undoLabel = label,
  ): HTMLElement {
    const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, 'aria-label': label });
    const out = h('output', { class: 'insp-value' });
    input.addEventListener('input', () => {
      if (!this.store.inGesture) this.store.beginGesture(undoLabel);
      set(Number(input.value));
      out.textContent = opts.format(Number(input.value));
      this.store.live();
    });
    input.addEventListener('change', () => this.store.endGesture());
    list.push({
      update: () => {
        const v = get();
        input.disabled = v === null;
        if (document.activeElement !== input && v !== null) input.value = String(v);
        out.textContent = v === null ? '—' : opts.format(v);
      },
    });
    return h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label), input, out);
  }

  private text(label: string, get: () => string | null, set: (v: string) => void, list: Binding[], placeholder?: () => string): HTMLElement {
    const input = h('input', { type: 'text', 'aria-label': label, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('change', () => set(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      e.stopPropagation();
    });
    list.push({
      update: () => {
        const v = get();
        input.disabled = v === null;
        if (document.activeElement !== input) input.value = v ?? '';
        if (placeholder) input.placeholder = placeholder();
      },
    });
    return h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label), input);
  }

  private select(label: string, options: () => VoiceOption[], get: () => string, set: (v: string) => void, list: Binding[]): HTMLSelectElement {
    const sel = h('select', { 'aria-label': label });
    sel.addEventListener('change', () => set(sel.value));
    list.push({
      update: () => {
        const opts = options();
        const sig = opts.map((o) => o.id + o.name).join('|');
        if (sel.dataset.sig !== sig) {
          sel.replaceChildren(...opts.map((o) => h('option', { value: o.id }, o.name)));
          sel.dataset.sig = sig;
        }
        sel.value = get();
      },
    });
    return sel;
  }

  // ---- note --------------------------------------------------------------

  private notes(): Note[] {
    return this.store.selectedNotes();
  }

  private first(): Note | null {
    return this.notes()[0] ?? null;
  }

  private setNotes(label: string, fn: (n: Note) => void): void {
    const ids = new Set(this.notes().map((n) => n.id));
    this.store.mutate(label, () => {
      for (const n of this.store.track.notes) if (ids.has(n.id)) fn(n);
    });
  }

  /** Slider that writes an override on all selected notes; shows the effective value. */
  private noteParam(label: string, key: 'vibratoDepth' | 'vibratoRate' | 'vibratoDelay' | 'portamento', opts: { min: number; max: number; step: number; format: (v: number) => string }): HTMLElement {
    return this.slider(
      label,
      opts,
      () => {
        const n = this.first();
        return n ? (n[key] ?? this.store.track.voiceParams[key]) : null;
      },
      (v) => {
        const ids = new Set(this.notes().map((n) => n.id));
        for (const n of this.store.track.notes) if (ids.has(n.id)) n[key] = v;
      },
      this.noteBindings,
    );
  }

  private noteInfo!: HTMLElement;

  private buildNoteSection(): void {
    const s = this.noteSection;
    this.noteInfo = h('div', { class: 'insp-info' });
    s.append(
      h('h3', {}, 'Note'),
      this.noteInfo,
      this.text(
        'Lyric',
        () => {
          const ns = this.notes();
          if (ns.length === 0) return null;
          return ns.every((n) => n.lyric === ns[0].lyric) ? ns[0].lyric : '';
        },
        (v) => this.setNotes('Edit lyric', (n) => (n.lyric = v.trim())),
        this.noteBindings,
      ),
      this.text(
        'Phonemes',
        () => (this.first() ? (this.first()!.phonemes ?? '') : null),
        (v) =>
          this.setNotes('Edit phonemes', (n) => {
            if (v.trim()) n.phonemes = v.trim();
            else delete n.phonemes;
          }),
        this.noteBindings,
        () => {
          const n = this.first();
          const ph = n ? this.render.phonemes(n.id) : undefined;
          return ph ? `auto: ${ph.join(' ').toLowerCase()}` : 'automatic';
        },
      ),
      h(
        'div',
        { class: 'insp-buttons' },
        h('button', { class: 'btn', onclick: () => this.setNotes('Transpose', (n) => (n.pitch = clampPitch(n.pitch - 12))) }, '−8va'),
        h('button', { class: 'btn', onclick: () => this.setNotes('Transpose', (n) => (n.pitch = clampPitch(n.pitch - 1))) }, '−1'),
        h('button', { class: 'btn', onclick: () => this.setNotes('Transpose', (n) => (n.pitch = clampPitch(n.pitch + 1))) }, '+1'),
        h('button', { class: 'btn', onclick: () => this.setNotes('Transpose', (n) => (n.pitch = clampPitch(n.pitch + 12))) }, '+8va'),
      ),
      this.noteParam('Vibrato', 'vibratoDepth', { min: 0, max: 1.5, step: 0.01, format: (v) => `${v.toFixed(2)} st` }),
      this.noteParam('Vib. rate', 'vibratoRate', { min: 3, max: 9, step: 0.1, format: (v) => `${v.toFixed(1)} Hz` }),
      this.noteParam('Vib. delay', 'vibratoDelay', { min: 0, max: 1.5, step: 0.01, format: (v) => `${v.toFixed(2)} s` }),
      this.noteParam('Glide', 'portamento', { min: 0.01, max: 0.4, step: 0.005, format: (v) => `${Math.round(v * 1000)} ms` }),
      h(
        'div',
        { class: 'insp-buttons' },
        h('button', { class: 'btn', onclick: () => this.hooks.editLyrics() }, 'Lyrics for selection…'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () =>
              this.setNotes('Reset note settings', (n) => {
                delete n.vibratoDepth;
                delete n.vibratoRate;
                delete n.vibratoDelay;
                delete n.portamento;
                delete n.phonemes;
              }),
          },
          'Use track defaults',
        ),
      ),
    );
  }

  private updateNoteInfo(): void {
    const ns = this.notes();
    if (ns.length === 0) {
      this.noteInfo.textContent = 'Tap a note to select it. Double-tap to type its lyric.';
      return;
    }
    if (ns.length > 1) {
      this.noteInfo.textContent = `${ns.length} notes selected`;
      return;
    }
    const n = ns[0];
    const ts = this.store.project.timeSignature;
    const beats = n.duration / PPQ;
    this.noteInfo.textContent = `${pitchName(n.pitch)} · bar ${formatBarBeat(n.onset, ts)} · ${beats.toFixed(beats % 1 ? 2 : 0)} beat${beats === 1 ? '' : 's'}`;
  }

  // ---- track -------------------------------------------------------------

  private trackParam(label: string, key: keyof VoiceParams, opts: { min: number; max: number; step: number; format: (v: number) => string }): HTMLElement {
    return this.slider(
      label,
      opts,
      () => this.store.track?.voiceParams[key] ?? null,
      (v) => {
        this.store.track.voiceParams[key] = v;
      },
      this.bindings,
    );
  }

  private buildTrackSection(): HTMLElement {
    const t = () => this.store.track as Track | undefined;
    const section = h('section', { class: 'insp-section' }, h('h3', {}, 'Track'));
    this.voiceSelect = this.select(
      'Voice',
      () => {
        const opts = this.hooks.voices();
        const cur = t()?.voice;
        if (cur && !opts.some((o) => o.id === cur)) opts.push({ id: cur, name: `${cur.replace(/^ds:/, '')} (not loaded)` });
        return opts;
      },
      () => t()?.voice ?? 'builtin:aria',
      (v) => this.store.mutate('Change voice', () => (this.store.track.voice = v)),
      this.bindings,
    );
    const lang = this.select(
      'Language',
      () => [
        { id: 'en', name: 'English' },
        { id: 'ja', name: 'Japanese' },
      ],
      () => t()?.language ?? 'en',
      (v) => this.store.mutate('Change language', () => (this.store.track.language = v === 'ja' ? 'ja' : 'en')),
      this.bindings,
    );
    this.voiceWarning = h('div', { class: 'insp-warning', hidden: true });
    section.append(
      this.text('Name', () => t()?.name ?? null, (v) => this.store.mutate('Rename track', () => (this.store.track.name = v.trim() || this.store.track.name)), this.bindings),
      h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, 'Voice'), this.voiceSelect),
      this.voiceWarning,
      h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, 'Language'), lang),
      this.slider('Volume', { min: -24, max: 12, step: 0.5, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` }, () => t()?.gainDb ?? null, (v) => (this.store.track.gainDb = v), this.bindings),
      this.slider('Pan', { min: -1, max: 1, step: 0.05, format: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) }, () => t()?.pan ?? null, (v) => (this.store.track.pan = v), this.bindings),
      h('h4', {}, 'Default expression'),
      this.trackParam('Vibrato', 'vibratoDepth', { min: 0, max: 1.5, step: 0.01, format: (v) => `${v.toFixed(2)} st` }),
      this.trackParam('Vib. rate', 'vibratoRate', { min: 3, max: 9, step: 0.1, format: (v) => `${v.toFixed(1)} Hz` }),
      this.trackParam('Vib. delay', 'vibratoDelay', { min: 0, max: 1.5, step: 0.01, format: (v) => `${v.toFixed(2)} s` }),
      this.trackParam('Glide', 'portamento', { min: 0.01, max: 0.4, step: 0.005, format: (v) => `${Math.round(v * 1000)} ms` }),
      this.trackParam('Gender', 'gender', { min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2) }),
      this.trackParam('Breathiness', 'breathiness', { min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2) }),
      this.trackParam('Tension', 'tension', { min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2) }),
      h(
        'div',
        { class: 'insp-buttons' },
        h('button', { class: 'btn', onclick: () => this.store.mutate('Reset expression', () => (this.store.track.voiceParams = { ...DEFAULT_VOICE_PARAMS })) }, 'Reset expression'),
      ),
    );
    return section;
  }

  // ---- project -----------------------------------------------------------

  private buildProjectSection(): HTMLElement {
    const section = h('section', { class: 'insp-section' }, h('h3', {}, 'Song'));
    const tempoInput = h('input', { type: 'number', min: 20, max: 400, step: 0.1, inputmode: 'decimal', 'aria-label': 'Tempo' });
    tempoInput.addEventListener('change', () => {
      const v = Number(tempoInput.value);
      if (!Number.isFinite(v) || v <= 0) return;
      this.store.mutate('Change tempo', (p) => {
        p.tempos[0] = { tick: 0, bpm: clampBpm(v) };
      });
    });
    tempoInput.addEventListener('keydown', (e) => e.stopPropagation());
    const num = h('select', { 'aria-label': 'Beats per bar' }, ...Array.from({ length: 12 }, (_, i) => h('option', { value: i + 1 }, String(i + 1))));
    const den = h('select', { 'aria-label': 'Beat unit' }, ...[2, 4, 8, 16].map((d) => h('option', { value: d }, String(d))));
    const setTs = () =>
      this.store.mutate('Change time signature', (p) => {
        p.timeSignature = { numerator: Number(num.value), denominator: Number(den.value) };
      });
    num.addEventListener('change', setTs);
    den.addEventListener('change', setTs);
    const markers = h('div', { class: 'tempo-list' });
    const addMarker = h('button', {
      class: 'btn',
      onclick: () => {
        const tick = Math.max(0, this.store.snapTick(this.store.tempo.secToTick(this.store.playhead)));
        if (tick === 0) return;
        const bpm = this.store.tempo.bpmAt(tick);
        this.store.mutate('Add tempo change', (p) => {
          p.tempos = [...p.tempos.filter((m) => m.tick !== tick), { tick, bpm }].sort((a, b) => a.tick - b.tick);
        });
      },
    }, 'Tempo change at playhead');
    this.bindings.push({
      update: () => {
        const p = this.store.project;
        if (document.activeElement !== tempoInput) tempoInput.value = String(Math.round(p.tempos[0].bpm * 100) / 100);
        num.value = String(p.timeSignature.numerator);
        den.value = String(p.timeSignature.denominator);
        markers.replaceChildren(
          ...p.tempos.slice(1).map((m) => {
            const input = h('input', { type: 'number', min: 20, max: 400, step: 0.1, value: Math.round(m.bpm * 100) / 100, inputmode: 'decimal', 'aria-label': 'Tempo' });
            input.addEventListener('keydown', (e) => e.stopPropagation());
            input.addEventListener('change', () => {
              const v = Number(input.value);
              if (!Number.isFinite(v) || v <= 0) return;
              this.store.mutate('Change tempo', (pp) => {
                const mm = pp.tempos.find((x) => x.tick === m.tick);
                if (mm) mm.bpm = clampBpm(v);
              });
            });
            return h(
              'div',
              { class: 'tempo-row' },
              h('span', {}, `Bar ${formatBarBeat(m.tick, p.timeSignature)}`),
              input,
              h('button', { class: 'btn icon-btn small', 'aria-label': 'Remove tempo change', onclick: () => this.store.mutate('Remove tempo change', (pp) => (pp.tempos = pp.tempos.filter((x) => x.tick !== m.tick))) }, '×'),
            );
          }),
        );
      },
    });
    section.append(
      this.text('Title', () => this.store.project.name, (v) => this.store.mutate('Rename song', (p) => (p.name = v.trim() || 'Untitled')), this.bindings),
      h('label', { class: 'insp-row' }, h('span', { class: 'insp-label' }, 'Tempo'), tempoInput, h('span', { class: 'insp-value' }, 'BPM')),
      h('div', { class: 'insp-row' }, h('span', { class: 'insp-label' }, 'Time sig.'), num, h('span', {}, '/'), den),
      markers,
      h('div', { class: 'insp-buttons' }, addMarker),
    );
    return section;
  }

  update(): void {
    const hasNotes = this.notes().length > 0;
    this.noteSection.classList.toggle('disabled', !hasNotes);
    for (const b of this.noteBindings) b.update();
    for (const b of this.bindings) b.update();
    this.updateNoteInfo();
    const voice = this.store.track?.voice ?? '';
    const known = this.hooks.voices().some((v) => v.id === voice);
    if (!isBuiltinVoice(voice) && !known) {
      this.voiceWarning.hidden = false;
      this.voiceWarning.replaceChildren(
        'This voicebank is not loaded on this device. ',
        h('button', { class: 'link', onclick: () => this.hooks.importVoicebank() }, 'Import it'),
        ' or ',
        h('button', { class: 'link', onclick: () => this.store.mutate('Change voice', () => (this.store.track.voice = BUILTIN_VOICES[0].id)) }, 'use a built-in voice'),
        '.',
      );
    } else {
      this.voiceWarning.hidden = true;
    }
  }
}
