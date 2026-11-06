import './ui/styles.css';
import { App } from './ui/app';

function start(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app element missing');
  const app = new App(root);
  // Exposed for debugging and automated tests.
  (window as unknown as { heloo: App }).heloo = app;
}

window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error ?? e.message);
});

start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err: unknown) => console.warn('Service worker registration failed', err));
  });
}
