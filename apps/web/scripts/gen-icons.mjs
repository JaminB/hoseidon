// Renders the PWA icons from the trident mark. Run: node scripts/gen-icons.mjs
// (needs Playwright's Chromium: `pnpm exec playwright install chromium`). Output is committed.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const GRADIENT =
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3cc9dc"/><stop offset="1" stop-color="#1690ad"/></linearGradient></defs>';
const TRIDENT =
  '<path d="M12 3v18"/><path d="M5.5 4.5V9a6.5 6.5 0 0 0 13 0V4.5"/><path d="M4 6.5 5.5 4.5 7 6.5M17 6.5l1.5-2 1.5 2M10.5 5 12 3l1.5 2"/><path d="M9.5 18.5h5"/>';
const mark = (transform) =>
  `<g transform="${transform}" fill="none" stroke="#fff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${TRIDENT}</g>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${GRADIENT}${body}</svg>`;

// "any": the rounded tile. "maskable": full bleed with the mark inside the 80% safe zone.
const ANY = svg(
  `<rect width="100" height="100" rx="24" fill="url(#g)"/>${mark('translate(18 18) scale(2.667)')}`,
);
const MASKABLE = svg(
  `<rect width="100" height="100" fill="url(#g)"/>${mark('translate(26 26) scale(2)')}`,
);

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const targets = [
  ['icon-192.png', ANY, 192],
  ['icon-512.png', ANY, 512],
  ['maskable-512.png', MASKABLE, 512],
  ['apple-touch-icon.png', MASKABLE, 180],
];

const browser = await chromium.launch();
for (const [name, source, size] of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  writeFileSync(out(name), await page.screenshot({ omitBackground: true }));
  await page.close();
}
await browser.close();
console.log('icons written');
