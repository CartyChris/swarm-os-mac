/*
 * The features that load code from cdn.jsdelivr.net at run time: KaTeX math,
 * the Pyodide Python runner, and Mermaid and React artifact previews. Needs
 * real internet, so it skips itself when the CDN is unreachable (it runs in CI).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startBridge } from "../bridge/swarm-bridge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
let bridge, browser, page, skip = null;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cdn-"));

before(async () => {
  try { const r = await fetch("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js", { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error("HTTP " + r.status); }
  catch (e) {
    if (process.env.REQUIRE_CDN) throw new Error("cdn.jsdelivr.net unreachable and REQUIRE_CDN is set: " + e.message);
    skip = "cdn.jsdelivr.net unreachable (" + e.message + ")"; return;
  }
  if (!CHROME) { skip = "no Chromium found"; return; }
  bridge = await startBridge({ port: 0, token: "t", home, env: { PATH: process.env.PATH, HOME: home }, quiet: true, serveApp: path.join(root, "app", "renderer", "swarm-os.html") });
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(bridge.url + "/");
  await page.waitForFunction(() => window.SWARM && SWARM.state.ready);
});
after(async () => { await browser?.close(); await bridge?.close(); fs.rmSync(home, { recursive: true, force: true }); });

const say = (content) => page.evaluate((c) => { const s = SWARM.currentSession(); s.messages.push({ id: "m" + Math.random(), role: "assistant", content: c, created: new Date().toISOString(), artifactIds: [] }); SWARM.render(); }, content);
const artifact = (name, fence, body) => page.evaluate(([n, f, b]) => { SWARM.liveFromText("cdn:" + n, "```" + f + ' title="' + n + '"\n' + b + "\n```", { sessionId: SWARM.currentSession().id }); SWARM.LIVE.active = n; SWARM.LIVE.view = "preview"; SWARM.dockOpen(true); }, [name, fence, body]);
const dock = () => page.frameLocator("#artifactDock .dock-frame");

test("KaTeX renders math in a reply", async (t) => {
  if (skip) return t.skip(skip);
  await say("Euler: $e^{i\\pi} + 1 = 0$ and $$\\sum_{k=1}^n k = \\frac{n(n+1)}{2}$$");
  await page.waitForSelector(".bubble .katex", { timeout: 30000 });
  assert.equal(await page.locator(".bubble .katex").count(), 2);
});

test("Python runs in the browser sandbox via Pyodide", async (t) => {
  if (skip) return t.skip(skip);
  await say("```python\nimport statistics\nprint('mean', statistics.mean([1, 2, 3, 4]))\nsum(range(10))\n```");
  await page.click('[data-run-code][data-lang="python"]');
  await page.waitForFunction(() => /finished|failed/.test(document.querySelector(".run-out .run-head")?.textContent || ""), null, { timeout: 180000 });
  const out = await page.locator(".run-out pre").innerText();
  assert.match(out, /mean 2\.5/);
  assert.match(out, /→ 45/);
});

test("a Mermaid artifact renders as a diagram", async (t) => {
  if (skip) return t.skip(skip);
  await artifact("flow.mmd", "mermaid", "graph TD\n  A[Ask] --> B{Swarm}\n  B --> C[Artifact]");
  await dock().locator("svg").first().waitFor({ timeout: 30000 });
  assert.match(await dock().locator("svg").first().innerHTML(), /Swarm/);
});

test("a React artifact compiles and renders (hooks and Tailwind available)", async (t) => {
  if (skip) return t.skip(skip);
  await artifact("counter.jsx", "jsx", "import React, { useState } from 'react';\nexport default function Counter() {\n  const [n, setN] = useState(41);\n  return <button className=\"px-4 py-2 rounded bg-blue-600 text-white\" onClick={() => setN(n + 1)}>Count {n}</button>;\n}");
  const btn = dock().locator("#root button");
  await btn.waitFor({ timeout: 30000 });
  await btn.click();
  assert.equal(await btn.innerText(), "Count 42");
});
