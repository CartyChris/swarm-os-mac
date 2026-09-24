#!/usr/bin/env node
/*
 * Renders build/icon.png (1024×1024) from the SVG below using headless
 * Chromium, so the icon is reproducible from source. electron-builder turns it
 * into the .icns. Set CHROME_PATH if Chromium is somewhere unusual.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));

// macOS icon grid: an 824px rounded square centred on a 1024px canvas.
const nodes = [[512, 330], [670, 421], [670, 603], [512, 694], [354, 603], [354, 421]];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
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
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="186" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="2"/>
  <circle cx="512" cy="512" r="300" fill="url(#glow)"/>
  <g stroke="url(#ring)" stroke-width="14" stroke-linecap="round" fill="none" opacity=".9">
    ${nodes.map(([x, y], i) => { const [x2, y2] = nodes[(i + 1) % nodes.length]; return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}"/>`; }).join("")}
    ${nodes.map(([x, y]) => `<line x1="512" y1="512" x2="${x}" y2="${y}" stroke-opacity=".55"/>`).join("")}
  </g>
  ${nodes.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 2 ? 34 : 40}" fill="${i % 2 ? "#73ddff" : "#ffdc87"}"/>`).join("")}
  <circle cx="512" cy="512" r="74" fill="#05070d" stroke="url(#ring)" stroke-width="16"/>
  <circle cx="512" cy="512" r="30" fill="#f7bd56"/>
</svg>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
fs.mkdirSync(path.join(root, "build"), { recursive: true });
await page.screenshot({ path: path.join(root, "build", "icon.png"), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
console.log("wrote build/icon.png");
