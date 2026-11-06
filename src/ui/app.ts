import { createNote, createTrack, PARAM_INFO, PARAM_NAMES, projectEndTick, sortedNotes, clampPitch, type Note, type ParamName } from '../core/model';
import { parseMidi, writeMidi } from '../core/midi';
import { parseProject, serializeProject } from '../core/project-io';
import { PPQ, formatBarBeat, formatSeconds } from '../core/time';
import { encodeWav } from '../core/wav';
import { RenderManager } from '../engine/client';
import { SAMPLE_RATE } from '../engine/plan';
import { BUILTIN_VOICES } from '../engine/voices';
import { Player, mixdown } from '../audio/player';
import { newId } from '../core/ids';
import { alertDialog, confirmDialog, showDialog, toast } from './dialogs';
import { h, pickFile, safeFilename, saveFile } from './dom';
import { icon } from './icons';
import { Inspector, type VoiceOption } from './inspector';
import { LyricEditor } from './lyric-editor';
import { ParamLane } from './paramlane';
import { PianoRoll } from './pianoroll';
import { SNAP_OPTIONS, Store, type Tool } from './store';
import { TrackList } from './tracks';

export class App {
  readonly store: Store;
  readonly render: RenderManager;
  readonly player = new Player();
  private roll!: PianoRoll;
  private lane!: ParamLane;
  private lyric!: LyricEditor;
  private inspector!: Inspector;
  private tracks!: TrackList;
  private readonly loadedVoices: VoiceOption[] = [];
  private statusEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private loopBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private laneTabs = new Map<ParamName, HTMLButtonElement>();
  private snapSelect!: HTMLSelectElement;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private exporting = false;

  constructor(private readonly root: HTMLElement) {
    this.store = new Store();
    this.render = new RenderManager(() => {
      if (typeof Worker === 'undefined') return null;
      return new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    });
    this.build();
    this.wire();
    this.applyMix();
    this.render.update(this.store.project);
    requestAnimationFrame(() => this.roll.fitToNotes());
    this.loop();
  }

  // ---- layout ------------------------------------------------------------

  private toolButton(tool: Tool, label: string, key: string): HTMLButtonElement {
    const b = h('button', {
      class: 'btn icon-btn tool',
      'aria-label': `${label} tool (${key})`,
      title: `${label} (${key})`,
      html: icon(tool),
      onclick: () => this.store.setTool(tool),
    });
    this.toolBtns.set(tool, b);
    return b;
  }

  private build(): void {
    const s = this.store;
    this.undoBtn = h('button', { class: 'btn icon-btn', 'aria-label': 'Undo', title: 'Undo (⌘Z)', html: icon('undo'), onclick: () => s.undo() });
    this.redoBtn = h('button', { class: 'btn icon-btn', 'aria-label': 'Redo', title: 'Redo (⇧⌘Z)', html: icon('redo'), onclick: () => s.redo() });
    this.snapSelect = h('select', { class: 'snap', 'aria-label': 'Snap', title: 'Snap to grid' }, ...SNAP_OPTIONS.map((o) => h('option', { value: o.ticks }, o.label)));
    this.snapSelect.addEventListener('change', () => {
      s.snap = Number(this.snapSelect.value);
      s.savePrefs();
      s.emit('tool');
    });
    this.playBtn = h('button', { class: 'btn icon-btn play', 'aria-label': 'Play', title: 'Play / Stop (Space)', html: icon('play'), onclick: () => this.togglePlay() });
    this.loopBtn = h('button', {
      class: 'btn icon-btn',
      'aria-label': 'Loop',
      'aria-pressed': 'false',
      title: 'Loop (L). Drag in the ruler to set the loop range.',
      html: icon('loop'),
      onclick: () => this.toggleLoop(),
    });
    this.timeEl = h('div', { class: 'time', 'aria-live': 'off' }, '1.1');
    this.statusEl = h('button', { class: 'status', title: 'Rendering status', onclick: () => this.onStatusClick() }, '');
    const menuBtn = h('button', { class: 'btn icon-btn', 'aria-label': 'Menu', 'aria-haspopup': 'true', title: 'Menu', html: icon('menu'), onclick: (e: Event) => this.openMenu(e.currentTarget as HTMLElement) });
    const tracksBtn = h('button', { class: 'btn icon-btn', 'aria-label': 'Show tracks', title: 'Tracks', html: icon('sidebar'), onclick: () => this.togglePanel('tracks') });
    const inspBtn = h('button', { class: 'btn icon-btn', 'aria-label': 'Show inspector', title: 'Inspector', html: icon('inspector'), onclick: () => this.togglePanel('inspector') });
    const lyricsBtn = h('button', { class: 'btn icon-btn', 'aria-label': 'Enter lyrics', title: 'Enter lyrics for selected notes', html: icon('lyrics'), onclick: () => void this.lyricsDialog() });

    const toolbar = h(
      'header',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, menuBtn, tracksBtn, h('span', { class: 'brand' }, 'Heloo')),
      h('div', { class: 'tb-group' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'tb-group tools', role: 'radiogroup', 'aria-label': 'Tools' }, this.toolButton('select', 'Select', 'V'), this.toolButton('pen', 'Pen', 'P'), this.toolButton('erase', 'Erase', 'E')),
      h('div', { class: 'tb-group' }, this.snapSelect, lyricsBtn),
      h(
        'div',
        { class: 'tb-group transport' },
        h('button', { class: 'btn icon-btn', 'aria-label': 'Go to start', title: 'Go to start (Home)', html: icon('start'), onclick: () => this.seek(0) }),
        this.playBtn,
        this.loopBtn,
        this.timeEl,
      ),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group' }, this.statusEl, inspBtn),
    );

    const rollWrap = h('div', { class: 'roll-wrap' });
    const laneHead = h('div', { class: 'lane-head', role: 'tablist', 'aria-label': 'Parameter' });
    for (const name of PARAM_NAMES) {
      const info = PARAM_INFO[name];
      const b = h('button', { class: 'lane-tab', role: 'tab', title: info.hint, onclick: () => ((s.paramLane = name), s.emit('tool')) }, info.short);
      this.laneTabs.set(name, b);
      laneHead.appendChild(b);
    }
    const laneWrap = h('div', { class: 'lane-wrap' });
    const editor = h('section', { class: 'editor' }, rollWrap, laneHead, laneWrap);

    this.tracks = new TrackList(s, (m) => confirmDialog(m));
    this.inspector = new Inspector(s, this.render, {
      voices: () => this.voices(),
      importVoicebank: () => void this.importVoicebank(),
      editLyrics: () => void this.lyricsDialog(),
    });
    const main = h('div', { class: 'main' }, this.tracks.el, editor, this.inspector.el);
    this.root.replaceChildren(toolbar, main);

    this.roll = new PianoRoll(rollWrap, s, this.render, this.player, {
      editLyric: (id) => this.lyric.edit(id),
      seek: (sec) => this.seek(sec),
      toast: (m) => toast(m, 5000),
    });
    this.lane = new ParamLane(laneWrap, s);
    this.lyric = new LyricEditor(rollWrap, s, this.roll);
    this.updatePanels();
    this.updateToolbar();
  }

  private voices(): VoiceOption[] {
    return [...BUILTIN_VOICES.map((v) => ({ id: v.id, name: `${v.name} (built-in)` })), ...this.loadedVoices];
  }

  private togglePanel(which: 'tracks' | 'inspector'): void {
    const s = this.store;
    if (which === 'tracks') s.tracksOpen = !s.tracksOpen;
    else s.inspectorOpen = !s.inspectorOpen;
    s.savePrefs();
    this.updatePanels();
  }

  private updatePanels(): void {
    this.root.classList.toggle('tracks-open', this.store.tracksOpen);
    this.root.classList.toggle('inspector-open', this.store.inspectorOpen);
  }

  // ---- wiring ------------------------------------------------------------

  private wire(): void {
    const s = this.store;
    s.on((kind) => {
      if (kind === 'project') {
        this.scheduleRender();
        this.applyMix();
      }
      if (kind !== 'live') this.updateToolbar();
    });
    this.render.on((ev, key) => {
      if (ev === 'ready' && key) {
        const p = this.render.phrase(key);
        if (p && this.player.playing && this.render.isCurrent(key)) this.player.schedule(p);
      } else if (ev === 'removed' && key) {
        this.player.unschedule(key);
      }
      if (ev === 'status') this.updateStatus();
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    // Prevent Safari's page pinch-zoom; the editor handles pinch itself.
    for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    window.addEventListener('pagehide', () => s.autosaveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        s.autosaveNow();
        if (this.player.playing) this.stop();
      }
    });
  }

  private scheduleRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render.update(this.store.project, this.player.time);
    }, 120);
  }

  private applyMix(): void {
    const tracks = this.store.project.tracks;
    const anySolo = tracks.some((t) => t.solo);
    for (const t of tracks) {
      const audible = !t.muted && (!anySolo || t.solo);
      this.player.setTrackMix(t.id, audible ? Math.pow(10, t.gainDb / 20) : 0, t.pan);
    }
  }

  private updateToolbar(): void {
    const s = this.store;
    this.undoBtn.disabled = !s.history.canUndo;
    this.redoBtn.disabled = !s.history.canRedo;
    this.undoBtn.title = s.history.undoLabel ? `Undo ${s.history.undoLabel} (⌘Z)` : 'Undo (⌘Z)';
    this.redoBtn.title = s.history.redoLabel ? `Redo ${s.history.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)';
    for (const [tool, b] of this.toolBtns) {
      b.classList.toggle('active', s.tool === tool);
      b.setAttribute('aria-pressed', String(s.tool === tool));
    }
    for (const [name, b] of this.laneTabs) {
      b.classList.toggle('active', s.paramLane === name);
      b.setAttribute('aria-selected', String(s.paramLane === name));
    }
    this.snapSelect.value = String(s.snap);
    this.loopBtn.classList.toggle('active', s.loop.enabled);
    this.loopBtn.setAttribute('aria-pressed', String(s.loop.enabled));
    this.playBtn.innerHTML = icon(this.player.playing ? 'stop' : 'play');
    this.playBtn.setAttribute('aria-label', this.player.playing ? 'Stop' : 'Play');
    this.root.dataset.tool = s.tool;
  }

  private updateStatus(): void {
    const st = this.render.status();
    let text: string;
    let cls = '';
    if (st.loadingDictionary) text = 'Loading dictionary…';
    else if (st.errors.length > 0) {
      text = `${st.errors.length > 1 ? `${st.errors.length} errors` : 'Render error'} – tap`;
      cls = 'error';
    } else if (st.ready < st.total) {
      text = `Rendering ${st.ready}/${st.total}`;
      cls = 'busy';
    } else text = st.total === 0 ? 'No notes' : 'Ready';
    if (this.store.autosaveError) {
      text += ' · not saved';
      cls = 'error';
    }
    this.statusEl.textContent = text;
    this.statusEl.className = `status ${cls}`;
  }

  private onStatusClick(): void {
    const st = this.render.status();
    if (st.errors.length > 0) {
      void showDialog('Rendering problems', h('ul', {}, ...st.errors.map((e) => h('li', {}, e))), [
        { label: 'Close', value: '' },
        { label: 'Retry', value: 'retry', primary: true },
      ]).then((v) => {
        if (v === 'retry') this.render.retryErrors();
      });
    } else if (this.store.autosaveError) {
      void alertDialog('Autosave failed', `Your project could not be saved on this device (${this.store.autosaveError}). Use Menu → Save project to keep a copy.`);
    }
  }

  // ---- transport ---------------------------------------------------------

  seek(sec: number): void {
    const t = Math.max(0, sec);
    this.store.playhead = t;
    if (this.player.playing) this.player.play(t, this.render.phrases());
    else this.player.seek(t);
    this.render.update(this.store.project, t);
    this.store.emit('transport');
  }

  togglePlay(): void {
    if (this.player.playing) this.stop();
    else this.play();
  }

  play(): void {
    if (!this.player.ensureContext()) {
      toast('Audio playback is not supported in this browser.');
      return;
    }
    let from = this.store.playhead;
    const s = this.store;
    if (s.loop.enabled) {
      const ls = s.tempo.tickToSec(s.loop.start);
      const le = s.tempo.tickToSec(s.loop.end);
      if (from < ls || from >= le) from = ls;
    }
    this.player.play(from, this.render.phrases());
    this.store.playing = true;
    this.updateToolbar();
  }

  stop(): void {
    this.player.stop();
    this.store.playing = false;
    this.store.playhead = this.player.time;
    this.updateToolbar();
  }

  private toggleLoop(): void {
    const s = this.store;
    s.loop.enabled = !s.loop.enabled;
    if (s.loop.enabled) {
      const sel = s.selectedNotes();
      if (sel.length > 0) {
        s.loop.start = Math.min(...sel.map((n) => n.onset));
        s.loop.end = Math.max(...sel.map((n) => n.onset + n.duration));
      } else if (s.loop.end <= s.loop.start) {
        s.loop.start = 0;
        s.loop.end = PPQ * 16;
      }
    }
    s.emit('transport');
    this.updateToolbar();
  }

  private loop(): void {
    const frame = () => {
      const s = this.store;
      if (this.player.playing) {
        let t = this.player.time;
        if (s.loop.enabled) {
          const le = s.tempo.tickToSec(s.loop.end);
          if (t >= le) {
            const ls = s.tempo.tickToSec(s.loop.start);
            this.player.play(ls, this.render.phrases());
            t = ls;
          }
        } else {
          const end = s.tempo.tickToSec(projectEndTick(s.project)) + 1;
          if (t > end) {
            this.stop();
            t = this.player.time;
          }
        }
        s.playhead = t;
        this.roll.follow(t);
        this.roll.dirty = true;
      }
      this.timeEl.textContent = `${formatBarBeat(Math.max(0, s.tempo.secToTick(s.playhead)), s.project.timeSignature)}  ${formatSeconds(s.playhead)}`;
      if (this.roll.dirty) this.roll.draw(s.playhead);
      if (this.lane.dirty) this.lane.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    this.store.on((k) => {
      if (k === 'transport') this.roll.dirty = true;
    });
  }

  // ---- editing commands --------------------------------------------------

  deleteSelection(): void {
    const s = this.store;
    if (s.selection.size === 0) return;
    const ids = new Set(s.selection);
    s.mutate('Delete notes', () => {
      s.track.notes = s.track.notes.filter((n) => !ids.has(n.id));
    });
    s.setSelection([]);
  }

  selectAll(): void {
    this.store.setSelection(this.store.track.notes.map((n) => n.id));
  }

  copy(cut = false): void {
    const s = this.store;
    const notes = sortedNotes(s.selectedNotes());
    if (notes.length === 0) return;
    const base = notes[0].onset;
    s.clipboard = { notes: notes.map(({ id: _id, ...rest }) => ({ ...rest, onset: rest.onset - base })) };
    if (cut) this.deleteSelection();
    toast(`${cut ? 'Cut' : 'Copied'} ${notes.length} note${notes.length > 1 ? 's' : ''}`, 1500);
  }

  paste(): void {
    const s = this.store;
    if (!s.clipboard || s.clipboard.notes.length === 0) return;
    const at = Math.max(0, s.snapTick(s.tempo.secToTick(s.playhead)));
    const created: Note[] = s.clipboard.notes.map((n) => ({ ...n, id: newId('n'), onset: n.onset + at }));
    s.mutate('Paste notes', () => s.track.notes.push(...created));
    s.setSelection(created.map((n) => n.id));
  }

  duplicate(): void {
    const s = this.store;
    const notes = s.selectedNotes();
    if (notes.length === 0) return;
    const start = Math.min(...notes.map((n) => n.onset));
    const end = Math.max(...notes.map((n) => n.onset + n.duration));
    const shift = s.snap > 0 ? Math.ceil((end - start) / s.snap) * s.snap : end - start;
    const created = notes.map((n) => ({ ...n, id: newId('n'), onset: n.onset + shift }));
    s.mutate('Duplicate notes', () => s.track.notes.push(...created));
    s.setSelection(created.map((n) => n.id));
  }

  transpose(semitones: number): void {
    const s = this.store;
    if (s.selection.size === 0) return;
    s.mutate('Transpose', () => {
      for (const n of s.track.notes) if (s.selection.has(n.id)) n.pitch = clampPitch(n.pitch + semitones);
    });
  }

  nudge(dir: number): void {
    const s = this.store;
    if (s.selection.size === 0) return;
    const step = s.snap > 0 ? s.snap : PPQ / 4;
    const notes = s.selectedNotes();
    const min = Math.min(...notes.map((n) => n.onset));
    const delta = Math.max(-min, dir * step);
    s.mutate('Move notes', () => {
      for (const n of s.track.notes) if (s.selection.has(n.id)) n.onset += delta;
    });
  }

  /** Splits each selected note in two at its middle (snapped). */
  split(): void {
    const s = this.store;
    const notes = s.selectedNotes();
    if (notes.length === 0) return;
    const created: string[] = [];
    s.mutate('Split notes', () => {
      for (const n of notes) {
        const live = s.track.notes.find((x) => x.id === n.id);
        if (!live || live.duration < 30) continue;
        let first = s.snapTick(live.duration / 2);
        if (first <= 0 || first >= live.duration) first = Math.round(live.duration / 2);
        const second = createNote(live.onset + first, live.duration - first, live.pitch, '-');
        live.duration = first;
        s.track.notes.push(second);
        created.push(live.id, second.id);
      }
    });
    s.setSelection(created);
  }

  private async lyricsDialog(): Promise<void> {
    const s = this.store;
    const notes = sortedNotes(s.track.notes);
    if (notes.length === 0) {
      toast('Add some notes first.');
      return;
    }
    const sel = s.selectedNotes();
    const startIdx = sel.length > 0 ? notes.findIndex((n) => n.id === sortedNotes(sel)[0].id) : 0;
    const count = sel.length > 1 ? sel.length : notes.length - startIdx;
    const targets = notes.slice(startIdx, startIdx + count);
    const area = h('textarea', { rows: 6, class: 'lyrics-area', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Lyrics' });
    area.value = targets.map((n) => n.lyric).join(' ');
    area.addEventListener('keydown', (e) => e.stopPropagation());
    const body = h(
      'div',
      {},
      h('p', { class: 'hint' }, `One word or syllable per note, separated by spaces (${targets.length} notes from the ${sel.length > 0 ? 'selection' : 'start'}). Use “+” to put the next syllable of a word on a note, “-” to hold the previous vowel, and “br” for a breath. Japanese: type kana (さくら) or romaji.`),
      area,
    );
    const v = await showDialog('Lyrics', body, [
      { label: 'Cancel', value: '' },
      { label: 'Apply', value: 'ok', primary: true },
    ]);
    if (v !== 'ok') return;
    const words = splitLyrics(area.value, s.track.language);
    const ids = targets.map((n) => n.id);
    s.mutate('Enter lyrics', () => {
      ids.forEach((id, i) => {
        const n = s.track.notes.find((x) => x.id === id);
        if (n && i < words.length) n.lyric = words[i];
      });
    });
    if (words.length > ids.length) toast(`${words.length - ids.length} extra word(s) did not fit and were ignored.`);
  }

  // ---- files ---------------------------------------------------------------

  private async saveProject(): Promise<void> {
    const p = this.store.project;
    await saveFile(new Blob([serializeProject(p)], { type: 'application/json' }), `${safeFilename(p.name)}.heloo.json`);
  }

  private async openProject(): Promise<void> {
    const file = await pickFile();
    if (!file) return;
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.mid') || file.name.toLowerCase().endsWith('.midi')) {
        await this.importMidiBuffer(await file.arrayBuffer());
        return;
      }
      const project = parseProject(text);
      this.stop();
      this.store.load(project);
      this.seek(0);
      this.roll.fitToNotes();
      toast(`Opened “${project.name}”`);
    } catch (err) {
      void alertDialog('Could not open file', err instanceof Error ? err.message : String(err));
    }
  }

  private async importMidi(): Promise<void> {
    const file = await pickFile();
    if (!file) return;
    try {
      await this.importMidiBuffer(await file.arrayBuffer());
    } catch (err) {
      void alertDialog('Could not import MIDI', err instanceof Error ? err.message : String(err));
    }
  }

  private async importMidiBuffer(buf: ArrayBuffer): Promise<void> {
    const song = parseMidi(buf);
    if (song.tracks.length === 0) {
      void alertDialog('Nothing to import', 'This MIDI file has no notes.');
      return;
    }
    const s = this.store;
    const empty = s.project.tracks.every((t) => t.notes.length === 0);
    const lang = s.track?.language ?? 'en';
    let firstId = '';
    s.mutate('Import MIDI', (p) => {
      if (empty) {
        p.tempos = song.tempos.map((t) => ({ tick: t.tick, bpm: t.bpm }));
        p.timeSignature = song.timeSignature;
        p.tracks = [];
      }
      for (const mt of song.tracks) {
        const t = createTrack(p.tracks.length, { name: mt.name, language: lang });
        t.notes = mt.notes.map((n) => createNote(n.onset, Math.max(15, n.duration), clampPitch(n.pitch), n.lyric ?? (lang === 'ja' ? 'ら' : 'la')));
        if (!firstId) firstId = t.id;
        p.tracks.push(t);
      }
    });
    if (firstId) s.selectTrack(firstId);
    this.roll.fitToNotes();
    toast(`Imported ${song.tracks.length} track${song.tracks.length > 1 ? 's' : ''} from MIDI`);
  }

  private async exportMidi(): Promise<void> {
    const p = this.store.project;
    const bytes = writeMidi({
      tempos: p.tempos,
      timeSignature: p.timeSignature,
      tracks: p.tracks.map((t) => ({ name: t.name, notes: sortedNotes(t.notes).map((n) => ({ onset: n.onset, duration: n.duration, pitch: n.pitch, lyric: n.lyric })) })),
    });
    await saveFile(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), `${safeFilename(p.name)}.mid`);
  }

  async exportWav(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    try {
      this.render.update(this.store.project);
      toast('Rendering for export…', 60000);
      await this.render.whenIdle();
      const st = this.render.status();
      if (st.errors.length > 0) {
        void alertDialog('Export incomplete', `Some phrases failed to render: ${st.errors.join('; ')}`);
        return;
      }
      const tracks = this.store.project.tracks;
      const anySolo = tracks.some((t) => t.solo);
      const mix = tracks
        .filter((t) => !t.muted && (!anySolo || t.solo))
        .map((t) => ({ trackId: t.id, gain: Math.pow(10, t.gainDb / 20), pan: t.pan }));
      const [L, R] = mixdown(this.render.phrases(), mix, SAMPLE_RATE);
      let peak = 0;
      for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      const wav = encodeWav([L, R], SAMPLE_RATE, 16);
      await saveFile(new Blob([wav], { type: 'audio/wav' }), `${safeFilename(this.store.project.name)}.wav`);
      toast(peak > 1 ? 'Exported. Some peaks clipped; lower the track volumes.' : 'Exported WAV', 4000);
    } catch (err) {
      void alertDialog('Export failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.exporting = false;
    }
  }

  private async newProject(): Promise<void> {
    const hasNotes = this.store.project.tracks.some((t) => t.notes.length > 0);
    if (hasNotes && !(await confirmDialog('Start a new song? The current one is replaced (save it first if you want to keep it).', 'New song'))) return;
    this.stop();
    this.store.newProject();
    this.seek(0);
    this.roll.fitToNotes();
  }

  private async importVoicebank(): Promise<void> {
    const file = await pickFile('.zip,application/zip');
    if (!file) return;
    const id = `ds:${safeFilename(file.name.replace(/\.zip$/i, '')).replace(/\s+/g, '_')}`;
    toast(`Loading voicebank “${file.name}”…`, 120000);
    try {
      const buf = await file.arrayBuffer();
      const reply = await this.render.loadVoicebank(id, { 'voicebank.zip': buf });
      if (!reply.ok) {
        toast('Voicebank not loaded', 1000);
        void alertDialog('Could not load voicebank', reply.message);
        return;
      }
      const info = (reply.info ?? {}) as { name?: string; warnings?: string[] };
      const name = `${info.name ?? id.slice(3)} (neural)`;
      const existing = this.loadedVoices.find((v) => v.id === id);
      if (existing) existing.name = name;
      else this.loadedVoices.push({ id, name });
      this.render.invalidateVoice(id);
      toast(`Voicebank loaded: ${name}`);
      const warn = info.warnings?.length ? `\n\nNotes:\n• ${info.warnings.join('\n• ')}` : '';
      const v = await showDialog('Voicebank loaded', `“${name}” runs locally on this device.${warn}\n\nUse it for the current track?`, [
        { label: 'Not now', value: '' },
        { label: 'Use for this track', value: 'use', primary: true },
      ]);
      if (v === 'use') this.store.mutate('Change voice', () => (this.store.track.voice = id));
      this.inspector.update();
    } catch (err) {
      void alertDialog('Could not load voicebank', err instanceof Error ? err.message : String(err));
    }
  }

  private showHelp(): void {
    const rows: [string, string][] = [
      ['Add a note', 'Pen tool: tap or drag in the grid. Select tool: double-tap empty space.'],
      ['Type lyrics', 'Double-tap a note. Enter/Tab moves to the next note. Several words fill following notes.'],
      ['Move / resize', 'Drag a note; drag its left or right edge to change length.'],
      ['Select several', 'Select tool: drag on empty space. Shift/⌘-tap adds to the selection.'],
      ['Scroll & zoom', 'Two fingers drag to scroll and pinch to zoom (horizontal or vertical spread). With Apple Pencil, one finger scrolls.'],
      ['Curves', 'Pick a parameter under the roll and draw with the Pencil or a finger. The Erase tool resets it.'],
      ['Seek / loop', 'Tap the ruler to move the playhead. With loop on, drag in the ruler to set the loop range.'],
      ['Special lyrics', '“+” next syllable of the previous word · “-” hold the previous vowel · “br” breath · “.hh ah” type phonemes directly.'],
      ['Keyboard', 'Space play · ⌘Z/⇧⌘Z undo/redo · V/P/E tools · ⌫ delete · ⌘A/C/X/V/D · ↑↓ transpose (⇧ octave) · ←→ move · Enter lyric · L loop · S split'],
    ];
    void showDialog(
      'How to use Heloo',
      h(
        'div',
        { class: 'help' },
        h('table', {}, ...rows.map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, b)))),
        h(
          'p',
          { class: 'hint' },
          'Everything runs on this device: the built-in voices are synthesized locally and nothing is uploaded. Install it from Safari with Share → Add to Home Screen to use it offline like an app.',
        ),
      ),
    );
  }

  private showAbout(): void {
    void showDialog(
      'About Heloo Vocal Studio',
      h(
        'div',
        {},
        h('p', {}, 'An original, touch-first singing voice editor for iPad. Version 0.1.'),
        h(
          'p',
          { class: 'hint' },
          'Built-in voices use an on-device formant synthesizer. Optional neural voices use open DiffSinger-format voicebanks that you import yourself, run locally with ONNX Runtime Web. English pronunciations come from the CMU Pronouncing Dictionary.',
        ),
      ),
    );
  }

  private openMenu(anchor: HTMLElement): void {
    document.querySelector('.menu-pop')?.remove();
    const s = this.store;
    const item = (label: string, fn: () => void, extra = '') =>
      h('button', {
        role: 'menuitem',
        class: extra,
        onclick: () => {
          pop.remove();
          fn();
        },
      }, label);
    const pop = h(
      'div',
      { class: 'menu-pop', role: 'menu' },
      item('New song', () => void this.newProject()),
      item('Open…', () => void this.openProject()),
      item('Save project', () => void this.saveProject()),
      h('hr'),
      item('Import MIDI…', () => void this.importMidi()),
      item('Export WAV', () => void this.exportWav()),
      item('Export MIDI', () => void this.exportMidi()),
      h('hr'),
      item('Import neural voicebank (.zip)…', () => void this.importVoicebank()),
      item(`${s.pencilOnly ? '✓ ' : ''}Pencil edits, finger scrolls`, () => {
        s.pencilOnly = !s.pencilOnly;
        s.savePrefs();
        toast(s.pencilOnly ? 'One finger now scrolls; edit with Apple Pencil.' : 'Fingers edit notes again; scroll with two fingers.');
      }),
      h('hr'),
      item('Help', () => this.showHelp()),
      item('About', () => this.showAbout()),
    );
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    document.body.appendChild(pop);
    const close = (e: Event) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
        pop.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    (pop.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  // ---- keyboard --------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (document.querySelector('.overlay')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const s = this.store;
    let handled = true;
    if (mod && k === 'z') {
      if (e.shiftKey) s.redo();
      else s.undo();
    } else if (mod && k === 'y') s.redo();
    else if (mod && k === 'a') this.selectAll();
    else if (mod && k === 'c') this.copy();
    else if (mod && k === 'x') this.copy(true);
    else if (mod && k === 'v') this.paste();
    else if (mod && k === 'd') this.duplicate();
    else if (mod && k === 's') void this.saveProject();
    else if (mod && k === 'o') void this.openProject();
    else if (mod) handled = false;
    else if (e.key === ' ') this.togglePlay();
    else if (e.key === 'Backspace' || e.key === 'Delete') this.deleteSelection();
    else if (k === 'v' || k === '1') s.setTool('select');
    else if (k === 'p' || k === '2') s.setTool('pen');
    else if (k === 'e' || k === '3') s.setTool('erase');
    else if (k === 'l') this.toggleLoop();
    else if (k === 's') this.split();
    else if (e.key === 'Home') this.seek(0);
    else if (e.key === 'ArrowUp') this.transpose(e.shiftKey ? 12 : 1);
    else if (e.key === 'ArrowDown') this.transpose(e.shiftKey ? -12 : -1);
    else if (e.key === 'ArrowLeft') this.nudge(-1);
    else if (e.key === 'ArrowRight') this.nudge(1);
    else if (e.key === 'Enter') {
      const first = sortedNotes(s.selectedNotes())[0];
      if (first) this.lyric.edit(first.id);
    } else if (e.key === 'Escape') s.setSelection([]);
    else handled = false;
    if (handled) e.preventDefault();
  }
}

/** Splits lyric text into per-note tokens. Kana text without spaces is split per mora. */
export function splitLyrics(text: string, language: 'en' | 'ja'): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (language !== 'ja') return words;
  const out: string[] = [];
  // Small kana and the sokuon attach to the previous mora (きゃ, きっ).
  const small = new Set([...'ゃゅょぁぃぅぇぉゎっャュョァィゥェォヮッ']);
  for (const w of words) {
    if (!/^[ぁ-ゖァ-ヺーー]+$/.test(w)) {
      out.push(w);
      continue;
    }
    for (const ch of w) {
      if (small.has(ch) && out.length > 0) out[out.length - 1] += ch;
      else out.push(ch);
    }
  }
  return out;
}
