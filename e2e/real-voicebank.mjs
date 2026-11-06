// Opt-in browser test with a real DiffSinger voicebank (not committed; see README).
// Usage: npm run build && HELOO_VOICEBANK=/path/voicebank.zip HELOO_VOCODER=/path/vocoder.oudep node e2e/real-voicebank.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const VOICEBANK = process.env.HELOO_VOICEBANK;
const VOCODER = process.env.HELOO_VOCODER;
if (!VOICEBANK || !VOCODER) {
  console.log('Set HELOO_VOICEBANK and HELOO_VOCODER to run this test.');
  process.exit(0);
}
const PORT = 4175;
const OUT = resolve('e2e/out');
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes(String(PORT)) && r()));

const browser = await chromium.launch();
let ok = true;
const log = (pass, name, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) ok = false;
};
try {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.startsWith('Ready'));

  // A short song: four one-beat notes with pinyin lyrics.
  await page.evaluate(() => {
    const app = window.heloo;
    app.store.newProject();
    app.store.mutate('test notes', (p) => {
      const t = p.tracks[0];
      [['ni', 60], ['hao', 62], ['ma', 64], ['la', 65]].forEach(([l, pitch], i) =>
        t.notes.push({ id: `n${i}`, onset: 960 + i * 480, duration: 480, pitch, lyric: l }));
    });
  });

  const t0 = Date.now();
  await page.click('button[aria-label="Menu"]');
  const [vbChooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.menu-pop >> text=Import neural voicebank')]);
  await vbChooser.setFiles(VOICEBANK);
  await page.waitForSelector('.dialog >> text=Vocoder needed', { timeout: 300000 });
  log(true, 'asks for a vocoder when the voicebank has none');
  const [vocChooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dialog >> text=Choose vocoder…')]);
  await vocChooser.setFiles(VOCODER);
  await page.waitForSelector('.dialog >> text=Use for this track', { timeout: 600000 });
  const loadedText = await page.locator('.dialog').innerText();
  log(true, 'voicebank loads in the browser', `${((Date.now() - t0) / 1000).toFixed(0)} s; ${loadedText.split('\n').filter(Boolean).slice(1, 4).join(' ')}`);
  await page.click('.dialog >> text=Use for this track');

  const t1 = Date.now();
  await page.waitForTimeout(500);
  await page.waitForFunction(() => {
    const s = window.heloo.render.status();
    return !s.loadingDictionary && s.total > 0 && s.ready + s.errors.length >= s.total;
  }, null, { timeout: 900000 });
  const result = await page.evaluate(() => {
    const app = window.heloo;
    const ph = app.render.phrases();
    let peak = 0;
    for (const p of ph) for (const v of p.samples) peak = Math.max(peak, Math.abs(v));
    return { voice: app.store.track.voice, phrases: ph.length, peak, errors: app.render.status().errors, phonemes: app.store.track.notes.map((n) => app.render.phonemes(n.id)?.join(' ')) };
  });
  log(result.errors.length === 0 && result.phrases === 1 && result.peak > 0.05, 'renders the phrase with the neural voice', `${((Date.now() - t1) / 1000).toFixed(0)} s; ${JSON.stringify(result)}`);

  await page.click('button[aria-label="Menu"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('.menu-pop >> text=Export WAV')]);
  const wavPath = `${OUT}/real-voicebank.wav`;
  await dl.saveAs(wavPath);
  log(readFileSync(wavPath).length > 44 + 44100 * 4, 'exports a WAV', wavPath);
  await page.screenshot({ path: `${OUT}/real-voicebank.png` });
  log(errors.length === 0, 'no page errors', errors.join(' | '));
} catch (err) {
  log(false, 'run completed', err instanceof Error ? err.stack : String(err));
} finally {
  await browser.close();
  server.kill();
}
process.exit(ok ? 0 : 1);
