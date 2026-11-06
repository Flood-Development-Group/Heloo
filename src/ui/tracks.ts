import { createTrack, type Track } from '../core/model';
import { newId } from '../core/ids';
import { h } from './dom';
import { icon } from './icons';
import type { Store } from './store';

/** Left-hand track list with mute/solo and track management. */
export class TrackList {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;

  constructor(
    private readonly store: Store,
    private readonly confirm: (msg: string) => Promise<boolean>,
  ) {
    this.list = h('div', { class: 'track-list', role: 'listbox', 'aria-label': 'Tracks' });
    this.el = h(
      'aside',
      { class: 'tracks' },
      h('div', { class: 'panel-head' }, h('span', {}, 'Tracks'), h('button', { class: 'btn icon-btn small', 'aria-label': 'Add track', title: 'Add track', html: icon('plus', 18), onclick: () => this.add() })),
      this.list,
    );
    store.on((k) => {
      if (k === 'project' || k === 'selection') this.update();
    });
    this.update();
  }

  private add(): void {
    const store = this.store;
    const t = createTrack(store.project.tracks.length, { language: store.track?.language ?? 'en', voice: store.track?.voice ?? 'builtin:aria' });
    store.mutate('Add track', (p) => p.tracks.push(t));
    store.selectTrack(t.id);
  }

  private duplicate(track: Track): void {
    const copy: Track = JSON.parse(JSON.stringify(track));
    copy.id = newId('t');
    copy.name = `${track.name} copy`;
    copy.notes = copy.notes.map((n) => ({ ...n, id: newId('n') }));
    this.store.mutate('Duplicate track', (p) => {
      const i = p.tracks.findIndex((t) => t.id === track.id);
      p.tracks.splice(i + 1, 0, copy);
    });
    this.store.selectTrack(copy.id);
  }

  private async remove(track: Track): Promise<void> {
    if (this.store.project.tracks.length <= 1) return;
    if (track.notes.length > 0 && !(await this.confirm(`Delete “${track.name}” and its ${track.notes.length} notes? You can undo this.`))) return;
    this.store.mutate('Delete track', (p) => (p.tracks = p.tracks.filter((t) => t.id !== track.id)));
  }

  private move(track: Track, dir: -1 | 1): void {
    this.store.mutate('Reorder tracks', (p) => {
      const i = p.tracks.findIndex((t) => t.id === track.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.tracks.length) return;
      [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
    });
  }

  update(): void {
    const store = this.store;
    const many = store.project.tracks.length > 1;
    this.list.replaceChildren(
      ...store.project.tracks.map((t, i) => {
        const selected = t.id === store.selectedTrackId;
        const toggle = (key: 'muted' | 'solo', label: string) =>
          h(
            'button',
            {
              class: `btn tiny ${t[key] ? 'on' : ''} ${key}`,
              'aria-pressed': String(t[key]),
              'aria-label': `${label} ${t.name}`,
              onclick: (e: Event) => {
                e.stopPropagation();
                store.mutate(label, (p) => {
                  const tt = p.tracks.find((x) => x.id === t.id);
                  if (tt) tt[key] = !tt[key];
                });
              },
            },
            key === 'muted' ? 'M' : 'S',
          );
        const menu = h('details', { class: 'track-menu' });
        menu.append(
          h('summary', { class: 'btn tiny', 'aria-label': `More options for ${t.name}`, html: icon('more', 16) }),
          h(
            'div',
            { class: 'track-menu-pop' },
            h('button', { onclick: (e: Event) => (e.stopPropagation(), (menu.open = false), this.duplicate(t)) }, 'Duplicate'),
            i > 0 ? h('button', { onclick: (e: Event) => (e.stopPropagation(), (menu.open = false), this.move(t, -1)) }, 'Move up') : null,
            i < store.project.tracks.length - 1 ? h('button', { onclick: (e: Event) => (e.stopPropagation(), (menu.open = false), this.move(t, 1)) }, 'Move down') : null,
            many ? h('button', { class: 'danger', onclick: (e: Event) => (e.stopPropagation(), (menu.open = false), void this.remove(t)) }, 'Delete') : null,
          ),
        );
        return h(
          'div',
          {
            class: `track-row ${selected ? 'selected' : ''}`,
            role: 'option',
            'aria-selected': String(selected),
            tabindex: 0,
            onclick: () => store.selectTrack(t.id),
            onkeydown: (e: Event) => {
              if ((e as KeyboardEvent).key === 'Enter') store.selectTrack(t.id);
            },
          },
          h('span', { class: 'swatch', style: `background:${t.color}` }),
          h('span', { class: 'track-name' }, t.name, h('small', {}, `${t.notes.length} notes`)),
          toggle('muted', 'Mute'),
          toggle('solo', 'Solo'),
          menu,
        );
      }),
    );
  }
}
