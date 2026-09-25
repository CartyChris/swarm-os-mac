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
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
      const body = JSON.parse(b);
      seen.push(body);
      const last = [...body.messages].reverse().find((m) => m.role === "user");
      const lastText = String(typeof last?.content === "string" ? last.content : "");
      const toolDone = body.messages.some((m) => m.role === "tool");
      if (body.stream && /GAME/.test(lastText) && !/Definition of Done|criteria/i.test(lastText)) return streamSlow(res, gameReply(lastText));
      if (body.stream && /TOOLART/.test(lastText) && !toolDone) return streamToolCall(res);
      const sys = String(body.messages[0]?.role === "system" ? body.messages[0].content : "");
      if (/suggest what a user might sensibly ask next/.test(sys)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: '["What about mobile?","Show a code example","Make it faster"]' }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } }));
      }
      if (/strict independent judge/.test(sys)) {
        const score = { "judge-a": 90, "judge-b": 80, "judge-c": 20 }[body.model] ?? 75;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ accepted: score >= 70, score, summary: "s", reason: "r" + score, defects: score < 50 ? ["weak"] : [] }) }, finish_reason: "stop" }] }));
      }
      if (/MATHTEST/.test(lastText)) return streamSlow(res, "Energy: $E = mc^2$ and $$\\int_0^1 x^2\\,dx$$ but it costs $5 and $10 today.");
      if (/RUNTEST/.test(lastText)) return streamSlow(res, "Try:\n\n```js\nconst xs = [1, 2, 3];\nconsole.log('sum', xs.reduce((a, b) => a + b));\ntry { console.log(parent.SWARM ? 'LEAK' : 'isolated') } catch (e) { console.log('isolated') }\nreturn xs.length;\n```");
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


/* A "game" that proves three things from inside the sandboxed preview: it ran,
   the localStorage shim works, and messages reach the dock (via the error channel). */
function gameReply(prompt) {
  const v = /AGAIN/.test(prompt) ? "2" : "1";
  const html = [
    "<!doctype html>", "<html>", "<head>", "<title>Snake</title>",
    "<style>body{margin:0;background:#111;color:#0f0;font:16px monospace}</style>", "</head>", "<body>",
    "<canvas id=\"c\" width=\"320\" height=\"240\"></canvas>",
    "<script>",
    "localStorage.setItem('best', '" + v + "');",
    "const ctx = document.getElementById('c').getContext('2d');",
    ...Array.from({ length: 24 }, (_, i) => "ctx.fillRect(" + (i * 12) + ", 100, 10, 10); // segment " + i),
    "parent.postMessage({__swarmArtifact:1,type:'error',message:'STORAGE ' + localStorage.getItem('best')}, '*');",
    "</scr" + "ipt>", "</body>", "</html>"
  ].join("\n");
  return "Here is the game.\n\n```html title=\"snake.html\"\n" + html + "\n```\n\nUse the arrow keys.";
}
async function streamSlow(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const parts = text.match(/[\s\S]{1,40}/g);
  for (const p of parts) {
    res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] }) + "\n\n");
    await new Promise((r) => setTimeout(r, 35));
  }
  res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 50 } }) + "\n\n");
  res.end("data: [DONE]\n\n");
}
/* create_artifact whose JSON arguments arrive a few characters at a time. */
async function streamToolCall(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const args = JSON.stringify({ name: "notes.md", language: "markdown", content: "# Field notes\n\n" + Array.from({ length: 30 }, (_, i) => "- item " + i + " with \"quotes\" and \\u00e9 é").join("\n") });
  const send = (delta) => res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta }] }) + "\n\n");
  send({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "create_artifact", arguments: "" } }] });
  for (const p of args.match(/[\s\S]{1,25}/g)) { send({ tool_calls: [{ index: 0, function: { arguments: p } }] }); await new Promise((r) => setTimeout(r, 30)); }
  res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
  res.end("data: [DONE]\n\n");
}
/* A small MCP server (streamable HTTP): JSON for most replies, SSE for tools/call. */
const mcpLog = [];
const mcp = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const m = JSON.parse(b || "{}");
    mcpLog.push({ method: m.method, session: req.headers["mcp-session-id"] || null, auth: req.headers.authorization || null });
    if (m.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-42" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1" } } }));
    }
    if (!m.id) { res.writeHead(202); return res.end(); }
    if (req.headers["mcp-session-id"] !== "sess-42") { res.writeHead(400); return res.end("no session"); }
    if (m.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] } }));
    }
    if (m.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) + "\n\n");
      return res.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "Sunny in " + m.params.arguments.city }] } }) + "\n\n");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } }));
  });
});

let bridge, browser, page, skip = null;
const errors = [];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-home-"));

before(async () => {
  if (!CHROME) { skip = "no Chromium found (set CHROME_PATH)"; return; }
  try { await new Promise((resolve, reject) => { ollama.once("error", reject); ollama.listen(11434, "127.0.0.1", resolve); }); }
  catch { skip = "port 11434 is in use (a real Ollama?)"; return; }
  await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
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
  mcp.close();
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


test("an HTML app streams into the dock and previews before it is finished", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => { SWARM.state.settings.requireDoD = false; SWARM.state.settings.useTools = false; SWARM.state.layout = "simple"; SWARM.render(); });
  await page.evaluate(() => { window.__run = SWARM.runOrchestrator("Build me a GAME: snake"); });
  // Mid-stream: the dock is open, the item is still being written, and the preview already has partial HTML.
  const mid = await page.waitForFunction(() => {
    const it = [...SWARM.LIVE.items.values()].find((x) => x.name === "snake.html");
    const f = document.querySelector("#artifactDock .dock-frame");
    if (!it || it.status !== "writing" || !f || !f.srcdoc || !/segment 3/.test(f.srcdoc)) return null;
    return { open: !document.querySelector("#artifactDock").hidden, len: it.content.length, card: !!document.querySelector('.art-card.writing[data-dock-open="snake.html"]') };
  }, null, { timeout: 20000, polling: 50 }).then((h) => h.jsonValue());
  assert.equal(mid.open, true);
  assert.equal(mid.card, true, "chat should show a writing card in place of the code");
  await page.screenshot({ path: path.join(outDir, "artifact-streaming.png") });
  await page.evaluate(() => window.__run);
  const end = await page.evaluate(() => {
    const a = SWARM.state.artifacts.find((x) => x.name === "snake.html");
    return { version: a && a.version, status: [...SWARM.LIVE.items.values()].find((x) => x.name === "snake.html").status,
             full: a && a.content.length, codeInChat: /segment 12/.test(document.querySelector("#messages").innerText) };
  });
  assert.ok(end.full > mid.len, "mid-stream preview should have been partial");
  assert.deepEqual({ version: end.version, status: end.status, codeInChat: end.codeInChat }, { version: 1, status: "done", codeInChat: false });
  // The finished game ran in the sandbox with a working localStorage stand-in.
  await page.waitForFunction(() => SWARM.LIVE.error === "STORAGE 1", null, { timeout: 10000 });
});

test("re-emitting the same file becomes version 2", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => SWARM.runOrchestrator("Make the GAME faster, AGAIN"));
  const v = await page.evaluate(() => SWARM.state.artifacts.filter((x) => x.name === "snake.html").map((x) => x.version));
  assert.deepEqual(v, [2, 1]);
  await page.waitForFunction(() => SWARM.LIVE.error === "STORAGE 2", null, { timeout: 10000 });
  const opts = await page.$$eval('#artifactDock [data-role="versions"] option', (o) => o.map((x) => x.textContent));
  assert.deepEqual(opts, ["v2 · latest", "v1"]);
  await page.screenshot({ path: path.join(outDir, "artifact-v2.png") });
  await page.click('#artifactDock [data-dock="view-code"]');
  await page.screenshot({ path: path.join(outDir, "artifact-code.png") });
  await page.click('#artifactDock [data-dock="view-preview"]');
});

test("a create_artifact tool call streams into the dock from its partial JSON", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => { SWARM.state.settings.useTools = true; window.__run2 = SWARM.runOrchestrator("TOOLART please"); });
  const mid = await page.waitForFunction(() => {
    const it = [...SWARM.LIVE.items.values()].find((x) => x.name === "notes.md");
    return it && it.status === "writing" && it.content.includes("item 3") ? it.content.length : null;
  }, null, { timeout: 20000, polling: 30 }).then((h) => h.jsonValue());
  await page.evaluate(() => window.__run2);
  const a = await page.evaluate(() => SWARM.state.artifacts.find((x) => x.name === "notes.md"));
  assert.ok(a, "tool call should have saved notes.md");
  assert.ok(a.content.length > mid, "the dock saw the content before the call finished");
  assert.match(a.content, /item 29 with "quotes" and \\u00e9 é/);
});

test("fence and partial-JSON parsers handle the edge cases", async (t) => {
  if (skip) return t.skip(skip);
  const r = await page.evaluate(() => {
    const f = SWARM.scanFences("a\n```html title=\"x.html\"\n<p>1</p>\n```\nb\n````md\n# T\n```js\ninner\n```\n````\n```jsx\nexport default function App(){");
    const p1 = SWARM.partialJsonField('{"name":"a.html","content":"line\\nnext \\"q\\" \\u00e9', "content");
    const p2 = SWARM.partialJsonField('{"content":"abc\\', "content");
    return { f: f.map((x) => [x.lang, x.title, x.closed, x.code]), p1, p2 };
  });
  assert.deepEqual(r.f, [["html", "x.html", true, "<p>1</p>"], ["md", "", true, "# T\n```js\ninner\n```"], ["jsx", "", false, "export default function App(){"]]);
  assert.deepEqual(r.p1, { value: 'line\nnext "q" é', closed: false });
  assert.deepEqual(r.p2, { value: "abc", closed: false });
});


test("regenerate keeps the previous answer as a version you can switch back to", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => { SWARM.state.settings.useTools = false; SWARM.state.settings.followUps = false; });
  await page.evaluate(() => SWARM.doAction("new-session"));
  await page.evaluate(() => SWARM.runOrchestrator("first ask"));
  const firstId = await page.evaluate(() => SWARM.state.sessions[0].messages.at(-1).id);
  await page.click(`[data-action="msg-regen"][data-msg="${firstId}"]`);
  await page.waitForFunction(() => !SWARM.RUN.active && SWARM.currentSession().messages.at(-1).versions?.length === 1, null, { timeout: 15000 });
  const nav = await page.locator(".msg.assistant .ver b").last().innerText();
  assert.equal(nav, "2/2");
  const id = await page.evaluate(() => SWARM.currentSession().messages.at(-1).id);
  await page.click(`[data-action="msg-ver"][data-dir="-1"][data-msg="${id}"]`);
  await page.waitForFunction(() => document.querySelector(".msg.assistant .ver b")?.textContent === "1/2");
  // The conversation sent onward uses the version on screen.
  assert.equal(await page.evaluate(() => SWARM.msgView(SWARM.currentSession().messages.at(-1)).index), 0);
  assert.equal(await page.evaluate(() => SWARM.currentSession().messages.length), 2, "regenerate must not add messages");
});

test("editing a user message resends from that point", async (t) => {
  if (skip) return t.skip(skip);
  const uid = await page.evaluate(() => SWARM.currentSession().messages[0].id);
  await page.click(`[data-action="msg-edit"][data-msg="${uid}"]`);
  await page.fill(`[data-edit-msg="${uid}"]`, "edited ask");
  seen.length = 0;
  await page.click(`[data-action="msg-edit-save"][data-msg="${uid}"]`);
  await page.waitForFunction(() => !SWARM.RUN.active && SWARM.currentSession().messages.length === 2 && SWARM.currentSession().messages[0].content === "edited ask", null, { timeout: 15000 });
  const last = await page.evaluate(() => SWARM.currentSession().messages[1].content);
  assert.match(last, /edited ask/);
});

test("chats drawer: search, pin, rename, archive, export and import", async (t) => {
  if (skip) return t.skip(skip);
  await page.click('[data-action="chats-toggle"]');
  await page.fill("#chatSearch", "edited");
  const rows = await page.locator(".chat-row .chat-open").allTextContents();
  const dbg = await page.evaluate(() => SWARM.state.sessions.map((x) => ({ t: x.title, n: x.messages.length, hit: x.messages.filter((m) => /edited/i.test(m.content)).map((m) => m.role + ":" + m.content.slice(0, 50)) })));
  assert.equal(rows.length, 1, "search should match message text: " + JSON.stringify({ rows, dbg }));
  assert.equal(await page.evaluate(() => document.activeElement.id), "chatSearch", "typing must keep focus in the search box");
  await page.fill("#chatSearch", "");
  const sid = await page.evaluate(() => SWARM.currentSession().id);
  await page.click(`.chat-row.active [data-action="chat-pin"]`);
  await page.waitForFunction(() => document.querySelector(".chat-group-h")?.textContent === "Pinned");
  assert.ok(await page.evaluate((id) => SWARM.state.sessions.find((x) => x.id === id).pinned, sid));
  await page.click(`.chat-row.active [data-action="chat-rename"]`);
  await page.fill("#renameInput", "Renamed chat");
  await page.keyboard.press("Enter");
  await page.waitForFunction((id) => SWARM.state.sessions.find((x) => x.id === id).title === "Renamed chat", sid);
  await page.click(`.chat-row.active [data-action="chat-export"]`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-action="chat-export-fmt"][data-fmt="json"]')]);
  const file = path.join(outDir, "chat-export.json");
  await dl.saveAs(file);
  const exported = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(exported.session.title, "Renamed chat");
  // Import it back as a new chat (Open WebUI's shape is accepted too).
  await page.setInputFiles("#importChat", file);
  await page.waitForFunction(() => SWARM.state.sessions.filter((x) => x.title === "Renamed chat").length === 2);
  await page.click(`.chat-row.active [data-action="chat-archive"]`);
  await page.waitForFunction(() => SWARM.state.sessions.some((x) => x.title === "Renamed chat" && x.archived));
  await page.click('.chats-drawer [data-action="chats-close"]');
});

test("a temporary chat is never written to storage", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => SWARM.doAction("new-temp-session"));
  await page.evaluate(() => SWARM.runOrchestrator("temporary ask"));
  const r = await page.evaluate(async () => {
    const id = SWARM.currentSession().id;
    const stored = await SWARM.DB.all("sessions");
    return { temp: SWARM.currentSession().temporary, stored: stored.some((x) => x.id === id), msgs: SWARM.currentSession().messages.length };
  });
  assert.deepEqual(r, { temp: true, stored: false, msgs: 2 });
});

test("math renders (or degrades) and money is not mistaken for math", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => SWARM.doAction("new-session"));
  await page.evaluate(() => SWARM.runOrchestrator("MATHTEST"));
  const r = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".msg.assistant .bubble")].at(-1);
    return { raw: [...b.querySelectorAll(".math-raw, .katex")].map((x) => x.textContent), text: b.innerText };
  });
  assert.equal(r.raw.length, 2, "two math spans: " + JSON.stringify(r.raw));
  assert.match(r.text, /costs \$5 and \$10 today/);
});

test("code blocks run in a sandbox and show their output", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => SWARM.runOrchestrator("RUNTEST"));
  await page.locator('[data-run-code][data-lang="js"]').last().click();
  await page.waitForFunction(() => /sum 6[\s\S]*→ 3/.test([...document.querySelectorAll(".run-out pre")].map((x) => x.textContent).join("\n")), null, { timeout: 10000 });
  // The runner cannot reach this app (and so not the keys in its storage).
  const out = await page.evaluate(() => [...document.querySelectorAll(".run-out pre")].map((x) => x.textContent).join("\n"));
  assert.match(out, /isolated/);
  assert.doesNotMatch(out, /LEAK/);
});

test("typing / opens the prompt library and fills in variables", async (t) => {
  if (skip) return t.skip(skip);
  await page.fill("#chatInput", "");
  await page.type("#chatInput", "/tod");
  await page.waitForSelector(".slash-pop:not([hidden]) button.sel");
  assert.match(await page.locator(".slash-pop button.sel").innerText(), /\/today/);
  await page.keyboard.press("Enter");
  const v = await page.inputValue("#chatInput");
  assert.match(v, /^Today is .+\. Give me a brief on $/);
  assert.ok(!v.includes("{{"), "variables should be filled");
  await page.fill("#chatInput", "");
});

test("a model preset sends its instructions to its base model", async (t) => {
  if (skip) return t.skip(skip);
  seen.length = 0;
  const r = await page.evaluate(async () => {
    SWARM.state.settings.presets = [{ id: "pirate-x1", name: "Pirate", base: "ollama:llama3.2:3b", system: "Talk like a pirate.", temperature: "0.1" }];
    const res = await SWARM.callModel([{ role: "user", content: "hi" }], { ref: "preset:pirate-x1", stream: false });
    return { content: res.content, ready: SWARM.providerReady("preset") };
  });
  assert.equal(r.ready, true);
  assert.equal(seen[0].model, "llama3.2:3b");
  assert.equal(seen[0].messages[0].role, "system");
  assert.equal(seen[0].messages[0].content, "Talk like a pirate.");
  assert.equal(seen[0].temperature, 0.1);
});

test("follow-up suggestions appear under the latest reply and send on click", async (t) => {
  if (skip) return t.skip(skip);
  await page.evaluate(() => { SWARM.state.settings.followUps = true; });
  await page.evaluate(() => SWARM.runOrchestrator("tell me about snakes"));
  await page.waitForSelector(".followups .chip", { timeout: 10000 });
  assert.deepEqual(await page.locator(".followups .chip").allInnerTexts(), ["↳ What about mobile?", "↳ Show a code example", "↳ Make it faster"]);
  await page.locator(".followups .chip").first().click();
  await page.waitForFunction(() => !SWARM.RUN.active && SWARM.currentSession().messages.some((m) => m.role === "user" && m.content === "What about mobile?"), null, { timeout: 15000 });
});

test("ratings feed a per-model leaderboard in Library", async (t) => {
  if (skip) return t.skip(skip);
  const id = await page.evaluate(() => SWARM.currentSession().messages.filter((m) => m.role === "assistant").at(-1).id);
  await page.click(`[data-action="msg-rate"][data-dir="1"][data-msg="${id}"]`);
  await page.waitForFunction((mid) => SWARM.currentSession().messages.find((m) => m.id === mid).rating === 1, id);
  await page.evaluate(() => { SWARM.state.layout = "advanced"; SWARM.state.view = "library"; SWARM.render(); });
  const txt = await page.locator(".stage").innerText();
  assert.match(txt, /Your ratings[\s\S]*llama3\.2:3b\s+1\s+0/);
  await page.screenshot({ path: path.join(outDir, "library.png") });
  await page.evaluate(() => { SWARM.state.layout = "simple"; SWARM.render(); });
});

test("the web app is installable: manifest, icons and a service worker", async (t) => {
  if (skip) return t.skip(skip);
  // As a phone browser sees it: no native pairing, fresh storage.
  const ctx = await browser.newContext();
  await ctx.route((u) => !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u.toString()), (r) => r.abort());
  const web = await ctx.newPage();
  await web.goto(bridge.url + "/");
  await web.waitForFunction(() => window.SWARM && SWARM.state.ready);
  const r = await web.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const native = await (await fetch("/")).text();
    const man = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
    const icon = await fetch(man.icons[0].src);
    return { sw: !!reg.active, name: man.name, display: man.display, icon: icon.status, html: native.length > 1000 };
  });
  assert.deepEqual(r, { sw: true, name: "SWARM OS", display: "standalone", icon: 200, html: true });
  // Inside the Mac app no service worker is registered.
  assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), false);
  await ctx.close();
});


test("MCP: connect over streamable HTTP, tools join the swarm, calls need approval unless trusted", async (t) => {
  if (skip) return t.skip(skip);
  const url = "http://127.0.0.1:" + mcp.address().port + "/mcp";
  await page.evaluate(async (u) => {
    SWARM.state.settings.mcpServers = [{ id: "m1", name: "weather", url: u, token: "tok-1", enabled: true, trusted: false }];
    await SWARM.mcpConnect(SWARM.state.settings.mcpServers[0], true);
  }, url);
  const names = await page.evaluate(() => SWARM.orchestratorTools().map((x) => x.function.name));
  assert.ok(names.includes("mcp__weather__get_weather"), names.join(","));
  assert.ok(names.includes("read_artifact") && names.includes("preview_artifact"));
  assert.equal(mcpLog[0].method, "initialize");
  assert.equal(mcpLog[0].auth, "Bearer tok-1");
  assert.equal(mcpLog.find((x) => x.method === "tools/list").session, "sess-42", "session id must be carried (read through the bridge)");
  // Untrusted: the call waits for a person, in the simple layout too.
  await page.evaluate(() => { SWARM.state.layout = "simple"; SWARM.render(); window.__mcp = SWARM.mcpCallTool("mcp__weather__get_weather", { city: "Oslo" }, "Test"); });
  await page.waitForSelector("[data-approve]");
  await page.click("[data-approve]");
  const r = await page.evaluate(() => window.__mcp);
  assert.deepEqual({ ok: r.ok, content: r.content }, { ok: true, content: "Sunny in Oslo" });
  // Trusted: no prompt.
  const r2 = await page.evaluate(() => { SWARM.state.settings.mcpServers[0].trusted = true; return SWARM.mcpCallTool("mcp__weather__get_weather", { city: "Rome" }); });
  assert.equal(r2.content, "Sunny in Rome");
  await page.evaluate(() => { SWARM.state.layout = "advanced"; SWARM.state.view = "tools"; SWARM.render(); });
  await page.screenshot({ path: path.join(outDir, "tools-mcp.png") });
  await page.evaluate(() => { SWARM.state.layout = "simple"; SWARM.render(); });
});

test("judge panel: three judges, the median score and the majority decide", async (t) => {
  if (skip) return t.skip(skip);
  const v = await page.evaluate(async () => {
    Object.assign(SWARM.state.settings, { judgeFanout: 3, judgeModel: "ollama:judge-a", verifierModel: "ollama:judge-b", defaultAgentModel: "ollama:judge-c", jevJudging: false });
    const r = await SWARM.judgePanel("some work", "be good", "ollama:judge-a");
    Object.assign(SWARM.state.settings, { judgeFanout: 1, verifierModel: "ollama:llama3.2:3b", defaultAgentModel: "ollama:llama3.2:3b", judgeModel: "ollama:llama3.2:3b" });
    return r;
  });
  assert.equal(v.score, 80);
  assert.equal(v.accepted, true);
  assert.deepEqual(v.panel.map((p) => [p.model, p.score]), [["ollama:judge-a", 90], ["ollama:judge-b", 80], ["ollama:judge-c", 20]]);
});

test("web source policy blocks and allows by domain", async (t) => {
  if (skip) return t.skip(skip);
  const r = await page.evaluate(async () => {
    const S = SWARM.state.settings;
    S.webBlockDomains = "example.com"; S.webAllowDomains = "";
    const a = [SWARM.domainAllowed("https://sub.example.com/x"), SWARM.domainAllowed("https://notexample.com/")];
    const f = await SWARM.fetchUrl("https://example.com/page");
    S.webBlockDomains = ""; S.webAllowDomains = "github.com, arxiv.org";
    const b = [SWARM.domainAllowed("https://github.com/a"), SWARM.domainAllowed("https://docs.github.com/"), SWARM.domainAllowed("https://reddit.com/")];
    S.webAllowDomains = "";
    return { a, b, f };
  });
  assert.deepEqual(r.a, [false, true]);
  assert.deepEqual(r.b, [true, true, false]);
  assert.equal(r.f.ok, false);
  assert.match(r.f.error, /source policy/);
});

test("agents can read and show artifacts; request preview and diagnostics work", async (t) => {
  if (skip) return t.skip(skip);
  const r = await page.evaluate(async () => {
    const read = SWARM.artifactTool("read_artifact", { name: "snake.html" });
    const show = SWARM.artifactTool("preview_artifact", { name: "snake.html" });
    const miss = SWARM.artifactTool("read_artifact", { name: "nope.xyz" });
    const pv = SWARM.requestPreview("ollama:llama3.2:3b");
    const d = await SWARM.diagnostics();
    return { read: [read.ok, read.version, read.content.includes("<canvas")], show: show.ok, active: SWARM.LIVE.active, miss: miss.ok, curl: pv.curl, diag: d.map((x) => x.k) };
  });
  assert.deepEqual(r.read, [true, 2, true]);
  assert.equal(r.show, true); assert.equal(r.active, "snake.html"); assert.equal(r.miss, false);
  assert.match(r.curl, /127\.0\.0\.1:11434\/v1\/chat\/completions/);
  assert.match(r.curl, /"model":"llama3\.2:3b"/);
  assert.ok(r.diag.includes("Storage") && r.diag.includes("Bridge"));
});

test("Design Studio: wallpaper, texture and button styles apply", async (t) => {
  if (skip) return t.skip(skip);
  const d = await page.evaluate(() => {
    SWARM.state.view = "studio";
    const k = { ...SWARM.state.skin, wallpaper: "aurora", texture: "grid", buttonStyle: "neon", buttonShape: "pill" };
    SWARM.applySkin(k, false);
    const h = document.documentElement.dataset;
    const out = { w: h.wallpaper, t: h.texture, b: h.buttons, s: h.shape, bg: getComputedStyle(document.body, "::before").backgroundImage.slice(0, 15) };
    SWARM.applySkin({ ...k, wallpaper: "none", texture: "none", buttonStyle: "glass", buttonShape: "soft" }, false);
    return out;
  });
  assert.deepEqual({ w: d.w, t: d.t, b: d.b, s: d.s }, { w: "aurora", t: "grid", b: "neon", s: "pill" });
  assert.match(d.bg, /radial-gradient/);
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
