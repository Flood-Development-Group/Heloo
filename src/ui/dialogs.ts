import { h } from './dom';

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

/** Shows a modal dialog and resolves with the clicked button's value ('' when dismissed). */
export function showDialog(title: string, body: Node | string, buttons: DialogButton[] = [{ label: 'OK', value: 'ok', primary: true }]): Promise<string> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const close = (value: string) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close('');
      }
    };
    const dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title),
      h('div', { class: 'dialog-body' }, body),
      h(
        'div',
        { class: 'dialog-buttons' },
        ...buttons.map((b) =>
          h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, 'data-value': b.value, onclick: () => close(b.value) }, b.label),
        ),
      ),
    );
    const overlay: HTMLDivElement = h('div', { class: 'overlay' }, dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close('');
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    const focusTarget = dialog.querySelector<HTMLElement>('textarea, input, .btn.primary') ?? dialog.querySelector<HTMLElement>('.btn');
    focusTarget?.focus();
  });
}

export async function confirmDialog(message: string, okLabel = 'Delete'): Promise<boolean> {
  const v = await showDialog('Are you sure?', message, [
    { label: 'Cancel', value: '' },
    { label: okLabel, value: 'ok', primary: true, danger: true },
  ]);
  return v === 'ok';
}

export function alertDialog(title: string, message: string): Promise<string> {
  return showDialog(title, message);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, ms = 3500): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el?.classList.remove('show'), ms);
}
