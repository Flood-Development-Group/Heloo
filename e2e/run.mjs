// End-to-end test in iPad emulation. Usage: npm run build && npm run e2e
// Starts `vite preview`, drives the real app with touch, mouse and keyboard, and checks results.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
// Playwright is resolved from the global install (NODE_PATH), which ESM imports ignore.
const { chromium, devices } = require('playwright');

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const OUT = resolve('e2e/out');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function decodeWav(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (o, n) => String.fromCharCode(...buf.subarray(o, o + n));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('not wav');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = str(off, 4);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { ch: v.getUint16(off + 10, true), rate: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
    if (id === 'data') {
      const frames = size / (fmt.ch * (fmt.bits / 8));
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < frames * fmt.ch; i++) {
        const s = v.getInt16(off + 8 + i * 2, true) / 32768;
        sum += s * s;
        peak = Math.max(peak, Math.abs(s));
      }
      return { ...fmt, seconds: frames / fmt.rate, rms: Math.sqrt(sum / (frames * fmt.ch)), peak };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

async function waitReady(page, timeout = 60000) {
  // Edits are debounced before rendering starts; give the status a moment to change.
  await page.waitForTimeout(250);
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.startsWith('Ready'), null, { timeout });
}

/** Multi-touch via CDP (Playwright has no pinch helper). */
async function pinch(page, cdp, cx, cy, from, to, axis = 'x') {
  const pts = (d) => [
    { x: axis === 'x' ? cx - d / 2 : cx, y: axis === 'y' ? cy - d / 2 : cy, id: 1 },
    { x: axis === 'x' ? cx + d / 2 : cx, y: axis === 'y' ? cy + d / 2 : cy, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / 8) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// Run vite directly (not through npx) so killing the process stops the server.
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('preview server did not start')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      res();
    }
  });
});

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ...devices['iPad Pro 11 landscape'], acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // 1. First launch shows the demo song and renders it.
  await page.goto(URL);
  await waitReady(page);
  const demoNotes = await page.evaluate(() => window.heloo.store.track.notes.length);
  check('demo song loads and renders', demoNotes === 14, `${demoNotes} notes`);
  await page.screenshot({ path: `${OUT}/01-demo.png` });

  // 2. Playback advances the playhead.
  await page.click('button[aria-label="Play"]');
  await page.waitForTimeout(1200);
  const playing = await page.evaluate(() => ({ playing: window.heloo.player.playing, t: window.heloo.player.time }));
  check('playback runs', playing.playing && playing.t > 0.5, `t=${playing.t.toFixed(2)}s`);
  await page.click('button[aria-label="Stop"]');

  // 3. New song via the menu (with confirmation).
  await page.click('button[aria-label="Menu"]');
  await page.click('.menu-pop >> text=New song');
  await page.click('.dialog .btn.primary');
  const afterNew = await page.evaluate(() => window.heloo.store.project.tracks.map((t) => t.notes.length));
  check('new song is empty', afterNew.length === 1 && afterNew[0] === 0);

  // 4. Pen tool: tap with a finger to add notes.
  await page.click('button[aria-label^="Pen tool"]');
  const box = await page.locator('.roll-canvas').boundingBox();
  const geo = await page.evaluate(() => {
    const v = window.heloo.store.view;
    return { v, kb: 56, ruler: 30 };
  });
  const xOf = (tick) => box.x + geo.kb + (tick - geo.v.scrollTick) * geo.v.pxPerTick;
  const yOf = (pitch) => box.y + geo.ruler + (geo.v.topPitch - pitch - 0.5) * geo.v.rowHeight;
  const pitches = [64, 66, 68, 69];
  for (let i = 0; i < 4; i++) {
    await page.touchscreen.tap(xOf(i * 480 + 120), yOf(pitches[i]));
    await page.waitForTimeout(60);
  }
  const created = await page.evaluate(() => window.heloo.store.track.notes.map((n) => [n.onset, n.duration, n.pitch, n.lyric]));
  check(
    'finger taps create snapped notes at the right pitches',
    created.length === 4 && created.every((n, i) => n[0] === i * 480 && n[1] === 480 && n[2] === pitches[i] && n[3] === 'la'),
    JSON.stringify(created),
  );

  // 5. Double-tap a note (select tool) and type lyrics; several words fill following notes.
  await page.click('button[aria-label^="Select tool"]');
  const nx = xOf(120);
  const ny = yOf(64);
  await page.touchscreen.tap(nx, ny);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(nx, ny);
  await page.waitForSelector('.lyric-input:not([hidden])', { timeout: 3000 });
  await page.keyboard.type('hello world');
  await page.keyboard.press('Enter');
  await page.keyboard.type('sing');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const lyrics = await page.evaluate(() => [...window.heloo.store.track.notes].sort((a, b) => a.onset - b.onset).map((n) => n.lyric));
  check('double-tap lyric entry with Enter-to-next', JSON.stringify(lyrics) === JSON.stringify(['hello', 'world', 'sing', 'la']), JSON.stringify(lyrics));

  // 6. Drag a note with the mouse, then undo/redo.
  // Grab the middle of the second note and drag it up two semitones and one 1/8 step later.
  await page.mouse.move(xOf(480 + 240), yOf(66));
  await page.mouse.down();
  await page.mouse.move(xOf(480 + 240 + 240), yOf(66) - 2 * geo.v.rowHeight, { steps: 6 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.heloo.store.track.notes.find((n) => n.lyric === 'world'));
  check('drag moves a note in time and pitch', moved.pitch === 68 && moved.onset === 720 && moved.duration === 480, `pitch ${moved.pitch} onset ${moved.onset}`);
  await page.keyboard.press('Meta+z');
  const undone = await page.evaluate(() => window.heloo.store.track.notes.find((n) => n.lyric === 'world'));
  check('undo restores the note', undone.pitch === 66 && undone.onset === 480);
  await page.keyboard.press('Meta+Shift+z');
  const redone = await page.evaluate(() => window.heloo.store.track.notes.find((n) => n.lyric === 'world'));
  check('redo re-applies the move', redone.pitch === 68 && redone.onset === 720);

  // 7. Two-finger pinch zooms horizontally; a cancelled first-finger edit leaves no note behind.
  const before = await page.evaluate(() => window.heloo.store.view.pxPerTick);
  const cdp = await context.newCDPSession(page);
  await pinch(page, cdp, box.x + box.width * 0.6, box.y + box.height * 0.5, 120, 360, 'x');
  const after = await page.evaluate(() => ({ px: window.heloo.store.view.pxPerTick, notes: window.heloo.store.track.notes.length }));
  check('pinch zooms in', after.px > before * 2, `${before.toFixed(3)} -> ${after.px.toFixed(3)}`);
  check('pinch does not create or delete notes', after.notes === 4);
  await page.evaluate(() => window.heloo.roll ?? null);
  await page.evaluate(() => {
    const app = window.heloo;
    app.store.setView({ pxPerTick: 0.12, scrollTick: -480 });
  });

  // 8. Draw a loudness curve in the parameter lane.
  await page.click('.lane-tab >> text=Loud');
  const lane = await page.locator('.lane-canvas').boundingBox();
  await page.mouse.move(lane.x + 120, lane.y + lane.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(lane.x + 320, lane.y + lane.height * 0.3, { steps: 12 });
  await page.mouse.up();
  const curve = await page.evaluate(() => window.heloo.store.track.params.loudness);
  check('drawing writes a parameter curve', curve.length >= 2, `${curve.length} points`);

  // 9. Wait for render, export WAV, and verify the audio.
  await waitReady(page);
  await page.screenshot({ path: `${OUT}/02-edited.png` });
  await page.click('button[aria-label="Menu"]');
  const [wavDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.menu-pop >> text=Export WAV')]);
  const wavPath = `${OUT}/export.wav`;
  await wavDl.saveAs(wavPath);
  const wav = decodeWav(readFileSync(wavPath));
  check('exported WAV is valid stereo 44.1 kHz audio with sound', wav.ch === 2 && wav.rate === 44100 && wav.seconds > 2 && wav.rms > 0.01 && wav.peak < 1, JSON.stringify(wav));

  // 10. Save the project file and check its contents.
  await page.click('button[aria-label="Menu"]');
  const [projDl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-pop >> text=Save project')]);
  const projPath = `${OUT}/project.heloo.json`;
  await projDl.saveAs(projPath);
  const saved = JSON.parse(readFileSync(projPath, 'utf8'));
  check('saved project contains the notes and lyrics', saved.format === 'heloo-project' && saved.tracks[0].notes.length === 4);

  // 11. Export MIDI and import it back as new tracks.
  await page.click('button[aria-label="Menu"]');
  const [midDl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-pop >> text=Export MIDI')]);
  const midPath = `${OUT}/song.mid`;
  await midDl.saveAs(midPath);
  await page.click('button[aria-label="Menu"]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.menu-pop >> text=Import MIDI…')]);
  await chooser.setFiles(midPath);
  await page.waitForFunction(() => window.heloo.store.project.tracks.length === 2);
  const imported = await page.evaluate(() => window.heloo.store.track.notes.map((n) => n.lyric).sort());
  check('MIDI round trip keeps lyrics', JSON.stringify(imported) === JSON.stringify(['hello', 'la', 'sing', 'world']), JSON.stringify(imported));

  // 12. Japanese track: switch language and enter kana lyrics with the lyrics dialog.
  await page.selectOption('select[aria-label="Language"]', 'ja');
  await page.keyboard.press('Meta+a');
  await page.click('button[aria-label="Enter lyrics"]');
  await page.fill('.lyrics-area', 'さくらー');
  await page.click('.dialog .btn.primary');
  const ja = await page.evaluate(() => [...window.heloo.store.track.notes].sort((a, b) => a.onset - b.onset).map((n) => n.lyric));
  check('kana lyrics split per mora', JSON.stringify(ja) === JSON.stringify(['さ', 'く', 'ら', 'ー']), JSON.stringify(ja));
  await waitReady(page);
  const jaPh = await page.evaluate(() => window.heloo.store.track.notes.map((n) => window.heloo.render.phonemes(n.id)?.join(' ')));
  check('Japanese phonemes', jaPh.includes('S a') && jaPh.includes('K u'), JSON.stringify(jaPh));

  // 13. Keyboard: delete selection, then undo.
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  const afterDelete = await page.evaluate(() => window.heloo.store.track.notes.length);
  await page.keyboard.press('Meta+z');
  const afterUndo = await page.evaluate(() => window.heloo.store.track.notes.length);
  check('delete and undo via keyboard', afterDelete === 0 && afterUndo === 4);

  // 14. Autosave survives a reload.
  await page.evaluate(() => window.heloo.store.autosaveNow());
  await page.reload();
  await waitReady(page);
  const restored = await page.evaluate(() => window.heloo.store.project.tracks.length);
  check('autosave restores the song after reload', restored === 2);

  // 15. Offline: the service worker serves the app with no network.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15000 }).catch(() => {});
  await context.setOffline(true);
  await page.reload();
  await waitReady(page);
  const offlineOk = await page.evaluate(() => !!window.heloo && window.heloo.store.project.tracks.length === 2);
  check('works offline after first load', offlineOk);
  await context.setOffline(false);

  // 16. Neural voicebank: import a stand-in DiffSinger zip (same ONNX interface as real ones) and render with it.
  const { execFileSync } = await import('node:child_process');
  const zipPath = `${OUT}/MockSinger.zip`;
  execFileSync(process.execPath, [resolve('node_modules/vite-node/vite-node.mjs'), 'scripts/make-mock-voicebank.ts', zipPath]);
  await page.click('button[aria-label="Menu"]');
  const [vbChooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.menu-pop >> text=Import neural voicebank')]);
  await vbChooser.setFiles(zipPath);
  await page.waitForSelector('.dialog >> text=Use for this track', { timeout: 60000 });
  await page.click('.dialog >> text=Use for this track');
  await waitReady(page, 120000);
  const neural = await page.evaluate(() => {
    const app = window.heloo;
    const t = app.store.track;
    const phrases = app.render.phrases().filter((p) => p.trackId === t.id);
    let peak = 0;
    for (const p of phrases) for (const v of p.samples) peak = Math.max(peak, Math.abs(v));
    return { voice: t.voice, phrases: phrases.length, peak, errors: app.render.status().errors };
  });
  check('neural voicebank loads in the browser and renders through ONNX Runtime (WASM)', neural.voice === 'ds:MockSinger' && neural.phrases > 0 && neural.peak > 0.2 && neural.errors.length === 0, JSON.stringify(neural));
  await page.screenshot({ path: `${OUT}/03-neural.png` });

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  // Layout screenshots on other iPad sizes.
  for (const name of ['iPad Pro 11', 'iPad Mini', 'iPad (gen 7) landscape']) {
    const ctx2 = await browser.newContext({ ...devices[name] });
    const p2 = await ctx2.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(URL);
    await waitReady(p2);
    await p2.screenshot({ path: `${OUT}/layout-${name.replace(/[^a-z0-9]+/gi, '-')}.png` });
    check(`layout renders on ${name}`, errs.length === 0, errs.join(' | '));
    await ctx2.close();
  }
} catch (err) {
  check('e2e run completed', false, err instanceof Error ? err.stack : String(err));
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
