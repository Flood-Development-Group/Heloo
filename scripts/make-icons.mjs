// Renders the SVG app icon to the PNG sizes iOS and the web manifest need (uses the preinstalled Playwright).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Playwright is resolved from the global install (NODE_PATH), which ESM imports ignore.
const { chromium } = require('playwright');
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'public/icons');
const svg = readFileSync(resolve(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const sizes = [
  ['apple-touch-icon.png', 180, false],
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-512-maskable.png', 512, true],
];
for (const [name, size, maskable] of sizes) {
  await page.setViewportSize({ width: size, height: size });
  // iOS applies its own rounded mask, so the touch icon and maskable icon are full-bleed squares.
  const fullBleed = maskable || name === 'apple-touch-icon.png';
  const body = fullBleed ? svg.replace('rx="112"', 'rx="0"') : svg;
  await page.setContent(`<html><body style="margin:0;background:transparent">${body.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: resolve(dir, name), omitBackground: !fullBleed, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', name);
}
await browser.close();
