import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** ONNX Runtime Web loads these at runtime; they are served from ./ort/. */
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const ORT_DIR = resolve(__dirname, 'node_modules/onnxruntime-web/dist');

function onnxRuntimeFiles(): Plugin {
  return {
    name: 'heloo-onnxruntime-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/ort\/([^/?#]+)/.exec(req.url ?? '');
        if (!m || !ORT_FILES.includes(m[1])) return next();
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(resolve(ORT_DIR, m[1])));
      });
    },
    generateBundle() {
      for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(resolve(ORT_DIR, f)) });
    },
  };
}

/** Files from /public that the app shell needs offline. */
const PUBLIC_PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

function swSource(version: string, precache: string[]): string {
  return `// Generated at build time. Caches the app shell so Heloo works offline.
const VERSION = ${JSON.stringify(version)};
const SHELL = 'heloo-shell-' + VERSION;
const RUNTIME = 'heloo-runtime-v1';
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('heloo-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then((hit) => hit || fetch(req)),
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Cache lazily loaded files (e.g. the neural runtime) for offline use.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
`;
}

function serviceWorker(): Plugin {
  return {
    name: 'heloo-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.endsWith('.wasm') && !/ort[-.].*\.mjs$/.test(f));
      const precache = [...new Set([...PUBLIC_PRECACHE, ...files])];
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, precache) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [onnxRuntimeFiles(), serviceWorker()],
  worker: { format: 'es' },
  build: {
    target: ['safari15', 'es2022'],
    chunkSizeWarningLimit: 6000,
  },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
