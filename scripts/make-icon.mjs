#!/usr/bin/env node
/*
 * Renders the app icons from the SVG below using headless Chromium, so they are
 * reproducible from source: build/icon.png (1024², electron-builder turns it into
 * the .icns) and the web app's home-screen icons in app/renderer/icons/. Set CHROME_PATH if Chromium is somewhere unusual.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));

// macOS icon grid: an 824px rounded square centred on a 1024px canvas.
const nodes = [[512, 330], [670, 421], [670, 603], [512, 694], [354, 603], [354, 421]];
// fullBleed: the background fills the square (home-screen and maskable icons,
// which the OS clips itself); otherwise the macOS rounded-square layout.
const icon = ({ fullBleed = false, glyph = 1 } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141c30"/><stop offset="1" stop-color="#05070d"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffdc87"/><stop offset=".55" stop-color="#f7bd56"/><stop offset="1" stop-color="#73ddff"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#f7bd56" stop-opacity=".45"/><stop offset="1" stop-color="#f7bd56" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${fullBleed ? `<rect width="1024" height="1024" fill="url(#bg)"/>` : `<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="186" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="2"/>`}
  <g transform="translate(512 512) scale(${glyph}) translate(-512 -512)">
  <circle cx="512" cy="512" r="300" fill="url(#glow)"/>
  <g stroke="url(#ring)" stroke-width="14" stroke-linecap="round" fill="none" opacity=".9">
    ${nodes.map(([x, y], i) => { const [x2, y2] = nodes[(i + 1) % nodes.length]; return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}"/>`; }).join("")}
    ${nodes.map(([x, y]) => `<line x1="512" y1="512" x2="${x}" y2="${y}" stroke-opacity=".55"/>`).join("")}
  </g>
  ${nodes.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 2 ? 34 : 40}" fill="${i % 2 ? "#73ddff" : "#ffdc87"}"/>`).join("")}
  <circle cx="512" cy="512" r="74" fill="#05070d" stroke="url(#ring)" stroke-width="16"/>
  <circle cx="512" cy="512" r="30" fill="#f7bd56"/>
  </g>
</svg>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
async function render(file, size, opts) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${icon(opts).replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</div></body></html>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log("wrote " + path.relative(root, file));
}
const web = path.join(root, "app", "renderer", "icons");
await render(path.join(root, "build", "icon.png"), 1024, {});                                  // macOS app icon
await render(path.join(web, "icon-192.png"), 192, { fullBleed: true, glyph: 1.15 });            // PWA
await render(path.join(web, "icon-512.png"), 512, { fullBleed: true, glyph: 1.15 });
await render(path.join(web, "icon-maskable-512.png"), 512, { fullBleed: true, glyph: .9 });      // inside the 80% safe zone
await render(path.join(web, "apple-touch-icon.png"), 180, { fullBleed: true, glyph: 1.15 });     // iOS home screen
await browser.close();
