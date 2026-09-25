import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  startBridge, tinyYaml, discoverContinue, discoverCredentials, detectLocalServers, fill, parseDotEnv
} from "../bridge/swarm-bridge.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-bridge-test-"));
const home = path.join(tmp, "home");
const bin = path.join(tmp, "bin");
fs.mkdirSync(path.join(home, ".continue"), { recursive: true });
fs.mkdirSync(bin, { recursive: true });

const CONTINUE_YAML = `# Continue config
name: My Assistant
version: 1.0.0
schema: v1
models:
  - name: Qwen Coder (local)
    provider: ollama
    model: qwen2.5-coder:7b
    roles:
      - chat
      - edit
  - name: GPT via Continue
    provider: openai
    model: gpt-4.1
    apiKey: \${{ secrets.MY_OPENAI }}
    roles: [chat, apply]
  - name: Proxy model
    provider: openai
    model: some-model
    apiBase: https://my-gateway.example.com/v1
    apiKey: "sk-gateway-should-not-be-adopted"
  - uses: anthropic/claude-sonnet
context:
  - provider: code   # trailing comment
`;
fs.writeFileSync(path.join(home, ".continue", "config.yaml"), CONTINUE_YAML);
fs.writeFileSync(path.join(home, ".continue", ".env"), "MY_OPENAI=sk-continue-openai-123456\n");
fs.writeFileSync(path.join(tmp, "app.html"), "<!doctype html><title>SWARM OS</title>");

// A stand-in coding CLI: prints its argv after a short delay.
fs.writeFileSync(path.join(bin, "cn"), "#!/bin/sh\nsleep 0.3\nprintf 'ARGS:'\nfor a in \"$@\"; do printf '[%s]' \"$a\"; done\necho\n", { mode: 0o755 });

const env = { PATH: bin + path.delimiter + (process.env.PATH || ""), HOME: home };
let bridge, detectCalls = 0;

before(async () => {
  bridge = await startBridge({
    port: 0, token: "test-token", home, env, allowCli: true, quiet: true,
    serveApp: path.join(tmp, "app.html"),
    detectLocalServers: async () => { detectCalls++; return [{ provider: "ollama", name: "Ollama", url: "http://127.0.0.1:11434/v1", models: ["qwen2.5-coder:7b"] }]; }
  });
});
after(async () => { await bridge?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = (p, init = {}) => fetch(bridge.url + p, { ...init, headers: { "X-Swarm-Token": "test-token", "Content-Type": "application/json", ...(init.headers || {}) } });

test("fill() substitutes literally, so $-patterns in a prompt survive", () => {
  assert.equal(fill("{prompt}", "prompt", "costs $'5 and $& more"), "costs $'5 and $& more");
  assert.equal(fill("--m={model}", "model", "a$1b"), "--m=a$1b");
});

test("tinyYaml reads a Continue config", () => {
  const y = tinyYaml(CONTINUE_YAML);
  assert.equal(y.name, "My Assistant");
  assert.equal(y.models.length, 4);
  assert.deepEqual(y.models[0], { name: "Qwen Coder (local)", provider: "ollama", model: "qwen2.5-coder:7b", roles: ["chat", "edit"] });
  assert.deepEqual(y.models[1].roles, ["chat", "apply"]);
  assert.equal(y.models[1].apiKey, "${{ secrets.MY_OPENAI }}");
  assert.equal(y.models[3].uses, "anthropic/claude-sonnet");
  assert.deepEqual(y.context, [{ provider: "code" }]);
});

test("parseDotEnv handles export, quotes and trailing spaces", () => {
  assert.deepEqual(parseDotEnv("export A=1\nB=\"two\"  \n# c\nC='3'"), { A: "1", B: "two", C: "3" });
});

test("discoverContinue maps models, resolves secrets, refuses keys meant for other endpoints", () => {
  const c = discoverContinue(home, env);
  assert.equal(c.present, true);
  assert.equal(c.file, "~/.continue/config.yaml");
  assert.deepEqual(c.hubRefs, ["anthropic/claude-sonnet"]);
  assert.equal(c.models.length, 3);
  assert.equal(c.models[0].swarmProvider, "ollama");
  assert.deepEqual(c.keys, [{ provider: "openai", key: "sk-continue-openai-123456" }]);
  assert.equal(c.models[2].apiBase, "https://my-gateway.example.com/v1");
});

test("an env credential beats the one found in Continue", () => {
  const c = discoverCredentials(home, { ...env, OPENAI_API_KEY: "sk-env-winner-000000" });
  assert.equal(c.found.openai.key, "sk-env-winner-000000");
  const d = discoverCredentials(home, env);
  assert.equal(d.found.openai.source, "~/.continue/config.yaml");
});

test("hello requires the token and never returns key values", async () => {
  assert.equal((await fetch(bridge.url + "/v1/hello")).status, 401);
  assert.equal((await fetch(bridge.url + "/v1/hello", { headers: { "X-Swarm-Token": "test-tokeN" } })).status, 401);
  const r = await call("/v1/hello");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes("sk-continue-openai-123456"), "key value leaked into hello");
  const j = JSON.parse(text);
  assert.ok(j.providers.includes("openai"));
  assert.equal(j.continue.present, true);
  assert.equal(j.continue.models.length, 3);
  assert.ok(!text.includes("my-gateway.example.com"), "a resolved apiBase leaked into hello");
  assert.equal(j.continue.models[2].customApiBase, true);
  assert.equal(j.localServers[0].provider, "ollama");
  assert.ok(j.clis.find((c) => c.id === "continue").installed);
});

test("hello re-probes local servers, rate-limited unless rescan=1", async () => {
  const before = detectCalls;
  await call("/v1/hello"); await call("/v1/hello");
  assert.ok(detectCalls - before <= 1, "probed more than once inside the 5s window");
  await call("/v1/hello?rescan=1");
  assert.ok(detectCalls > before, "rescan=1 did not probe");
});

test("Host header must name the loopback listener", async () => {
  const status = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: bridge.port, path: "/v1/hello", headers: { Host: "evil.example:" + bridge.port, "X-Swarm-Token": "test-token" } },
      (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(status, 421);
});

test("serves the app at / without the token", async () => {
  const r = await fetch(bridge.url + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /SWARM OS/);
});

test("proxy refuses to send a credential to another provider's host", async () => {
  const r = await call("/v1/proxy", { method: "POST", body: JSON.stringify({ target: "http://127.0.0.1:9/x", credential: "openai" }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /only sent to api\.openai\.com/);
});

test("proxy refuses hosts off the allow-list", async () => {
  const r = await call("/v1/proxy", { method: "POST", body: JSON.stringify({ target: "https://example.com/" }) });
  assert.equal(r.status, 403);
});

test("proxy forwards to an allow-listed local upstream and streams back", async () => {
  const up = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ got: JSON.parse(b), auth: req.headers.authorization || null }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  try {
    const r = await call("/v1/proxy", { method: "POST", body: JSON.stringify({ target: "http://127.0.0.1:" + up.address().port + "/v1/chat", body: { hi: 1 } }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { got: { hi: 1 }, auth: null });
  } finally { up.close(); }
});

test("CLI agent runs to completion with the prompt intact", async () => {
  const r = await call("/v1/cli/run", { method: "POST", body: JSON.stringify({ cli: "continue", prompt: "costs $'5 and $& more" }) });
  assert.equal(r.status, 200);
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "start");
  assert.deepEqual(lines[0].args, ["-p", "<prompt>", "--silent"]);
  const out = lines.filter((l) => l.type === "stdout").map((l) => l.text).join("");
  assert.equal(out.trim(), "ARGS:[-p][costs $'5 and $& more][--silent]");
  assert.deepEqual(lines.at(-1), { type: "end", code: 0 });
});

test("CLI agents are refused when not allowed", async () => {
  const b2 = await startBridge({ port: 0, token: "t2", home, env, quiet: true, detectLocalServers: async () => [] });
  try {
    const r = await fetch(b2.url + "/v1/cli/run", { method: "POST", headers: { "X-Swarm-Token": "t2" }, body: JSON.stringify({ cli: "continue", prompt: "x" }) });
    assert.equal(r.status, 403);
  } finally { await b2.close(); }
});

test("skill names cannot escape the skills directory", async () => {
  const r = await call("/v1/skills", { method: "POST", body: JSON.stringify({ skills: [{ name: "../evil", content: "x" }, { name: "Good Skill", content: "# ok" }] }) });
  const j = await r.json();
  assert.deepEqual(j.written, [path.join("good-skill", "SKILL.md")]);
  assert.equal(j.rejected.length, 1);
  assert.ok(!fs.existsSync(path.join(home, ".swarm-os", "evil")));
});

test("detectLocalServers accepts model lists and ignores other servers", async () => {
  const models = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "llama3.2" }, { id: "qwen3" }] })); });
  const other = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>vite dev server</html>"); });
  await Promise.all([new Promise((r) => models.listen(0, "127.0.0.1", r)), new Promise((r) => other.listen(0, "127.0.0.1", r))]);
  try {
    const found = await detectLocalServers([
      { provider: "llamacpp", name: "llama.cpp", base: "b1", probe: "http://127.0.0.1:" + models.address().port + "/v1/models" },
      { provider: "textgenwebui", name: "tgw", base: "b2", probe: "http://127.0.0.1:" + other.address().port + "/v1/models" },
      { provider: "jan", name: "Jan", base: "b3", probe: "http://127.0.0.1:9/v1/models" }
    ]);
    assert.deepEqual(found, [{ provider: "llamacpp", name: "llama.cpp", url: "b1", models: ["llama3.2", "qwen3"] }]);
  } finally { models.close(); other.close(); }
});

test("aborting a proxied request cancels the upstream request", async () => {
  let upstreamClosed;
  const closed = new Promise((r) => (upstreamClosed = r));
  const up = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");                   // then never finish, like a long generation
    req.on("close", () => upstreamClosed(true));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  try {
    const ctl = new AbortController();
    const r = await call("/v1/proxy", { method: "POST", signal: ctl.signal, body: JSON.stringify({ target: "http://127.0.0.1:" + up.address().port + "/stream", method: "GET" }) });
    const reader = r.body.getReader();
    await reader.read();                             // the first chunk arrived
    ctl.abort();
    const result = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.equal(result, true, "upstream request stayed open after the client aborted");
  } finally { up.closeAllConnections(); up.close(); }
});

test("serves the web-app manifest, service worker and icons — and nothing else beside the app", async () => {
  const dir = path.dirname(path.join(tmp, "app.html"));
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, "sw.js"), "self.x=1");
  fs.mkdirSync(path.join(dir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(dir, "icons", "icon-192.png"), "PNG");
  fs.writeFileSync(path.join(dir, "secret.txt"), "nope");
  const m = await fetch(bridge.url + "/manifest.webmanifest");
  assert.equal(m.status, 200); assert.match(m.headers.get("content-type"), /manifest\+json/);
  const w = await fetch(bridge.url + "/sw.js");
  assert.equal(w.status, 200); assert.match(w.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(bridge.url + "/icons/icon-192.png")).status, 200);
  assert.equal((await fetch(bridge.url + "/secret.txt")).status, 404);
  assert.equal((await fetch(bridge.url + "/icons/../secret.txt")).status, 404);
  assert.equal((await fetch(bridge.url + "/icons/%2e%2e%2fsecret.png")).status, 404);
});
