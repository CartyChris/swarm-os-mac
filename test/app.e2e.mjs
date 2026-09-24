/*
 * End to end, in a real Chromium: the bridge serves the app, the page pairs
 * itself the way the macOS app does (window.swarmNative), finds a local
 * "Ollama", starts in free mode, and a call for a metered model is answered by
 * the local one through the bridge's proxy. The app's own selfTest() must pass.
 *
 * A stand-in Ollama listens on the real default port, 11434, so the page's
 * provider table is exercised unmodified. The test skips if that port is taken.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startBridge } from "../bridge/swarm-bridge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));

const seen = [];
const ollama = http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/api/tags") return json({ models: [{ name: "nomic-embed-text:latest" }, { name: "llama3.2:3b" }] });
  if (req.url === "/v1/models") return json({ object: "list", data: [{ id: "nomic-embed-text:latest" }, { id: "llama3.2:3b" }] });
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const body = JSON.parse(b);
      seen.push(body);
      const last = [...body.messages].reverse().find((m) => m.role === "user");
      const text = "FAKE-OLLAMA says hi to: " + String(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)).slice(0, 60);
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } }) + "\n\n");
        return res.end("data: [DONE]\n\n");
      }
      json({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } });
    });
    return;
  }
  res.writeHead(404); res.end();
});

let bridge, browser, page, skip = null;
const errors = [];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-home-"));

before(async () => {
  if (!CHROME) { skip = "no Chromium found (set CHROME_PATH)"; return; }
  try { await new Promise((resolve, reject) => { ollama.once("error", reject); ollama.listen(11434, "127.0.0.1", resolve); }); }
  catch { skip = "port 11434 is in use (a real Ollama?)"; return; }
  bridge = await startBridge({
    port: 0, token: "e2e-token", home, env: { PATH: process.env.PATH, HOME: home }, quiet: true, native: true,
    serveApp: path.join(root, "app", "renderer", "swarm-os.html")
  });
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await ctx.addInitScript(({ url, token }) => { window.swarmNative = { bridgeUrl: url, token, platform: "test" }; }, { url: bridge.url, token: "e2e-token" });
  // Keep the test hermetic: nothing leaves loopback (the page lazily loads three.js from a CDN).
  await ctx.route((u) => !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u.toString()), (r) => r.abort());
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(bridge.url + "/");
  await page.waitForFunction(() => window.SWARM && window.SWARM.state && window.SWARM.state.ready, null, { timeout: 30000 });
});
after(async () => {
  await browser?.close();
  await bridge?.close();
  await new Promise((r) => ollama.close(() => r()));
  fs.rmSync(home, { recursive: true, force: true });
});

test("pairs with the built-in bridge without a pasted token", { skip: false }, async (t) => {
  if (skip) return t.skip(skip);
  const b = await page.evaluate(() => ({ connected: SWARM.state.bridge.connected, native: SWARM.state.bridge.native, locals: SWARM.state.bridge.localServers.map((l) => l.provider) }));
  assert.deepEqual(b, { connected: true, native: true, locals: ["ollama"] });
});

test("first run with no paid keys starts in free mode on the local model", async (t) => {
  if (skip) return t.skip(skip);
  const s = await page.evaluate(() => ({ free: SWARM.state.settings.freeMode, orch: SWARM.state.settings.orchestratorModel, agent: SWARM.state.settings.defaultAgentModel, auto: SWARM.state.settings.freeAutoSetup }));
  assert.deepEqual(s, { free: true, orch: "ollama:llama3.2:3b", agent: "ollama:llama3.2:3b", auto: false });
});

test("a call for a metered model is served free by the local model, through the bridge", async (t) => {
  if (skip) return t.skip(skip);
  seen.length = 0;
  const r = await page.evaluate(async () => {
    const res = await SWARM.callModel([{ role: "user", content: "ping from e2e" }], { ref: "anthropic:claude-opus-5", stream: false, maxTokens: 20 });
    return { content: res.content, cost: SWARM.RUN.metrics.cost };
  });
  assert.match(r.content, /FAKE-OLLAMA says hi to: ping from e2e/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "llama3.2:3b");
  assert.equal(r.cost, 0);
});

test("with free mode on and no free model, a metered call is refused, not sent", async (t) => {
  if (skip) return t.skip(skip);
  seen.length = 0;
  const msg = await page.evaluate(async () => {
    const keep = SWARM.state.bridge;
    SWARM.state.bridge = { ...keep, localServers: [] };
    try { await SWARM.callModel([{ role: "user", content: "x" }], { ref: "anthropic:claude-opus-5", stream: false }); return "no error" }
    catch (e) { return String(e.message) }
    finally { SWARM.state.bridge = keep }
  });
  assert.match(msg, /Free mode is on and no free model is reachable/);
  assert.equal(seen.length, 0);
});

test("the app's own selfTest passes", async (t) => {
  if (skip) return t.skip(skip);
  const r = await page.evaluate(() => SWARM.selfTest());
  const failed = r.results.filter((x) => !x.pass);
  assert.deepEqual(failed, [], "selfTest failures:\n" + failed.map((f) => f.name + ": " + f.detail).join("\n"));
  assert.ok(r.pass > 40, "suspiciously few self-test checks: " + r.pass);
});

test("Free AI view renders and screenshots cleanly", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => { SWARM.state.layout = "advanced"; SWARM.state.view = "free"; SWARM.render(); });
  const text = await page.locator(".stage").innerText();
  assert.match(text, /Local model servers — unlimited/);
  assert.match(text, /llama3\.2:3b/);
  await page.screenshot({ path: path.join(outDir, "free-ai.png") });
  await page.evaluate(() => { SWARM.state.layout = "simple"; SWARM.render(); });
  await page.screenshot({ path: path.join(outDir, "simple.png") });
  assert.deepEqual(errors, []);
});
