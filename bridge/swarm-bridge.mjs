#!/usr/bin/env node
/*
 * SWARM OS BRIDGE
 * A small companion for the SWARM OS web app. Zero dependencies, Node 18+.
 *
 *   node swarm-bridge.mjs
 *
 * It does three jobs a web page cannot do for itself:
 *
 *   1. Reaches providers that refuse browser requests. api.z.ai, Cerebras,
 *      Tavily and Moonshot's Anthropic surface all reject cross-origin calls.
 *      This forwards them.
 *   2. Finds the credentials your CLIs already have, and uses them WITHOUT
 *      handing them to the browser. The page asks for "zai"; the key is
 *      attached here and never crosses into the tab.
 *   3. Runs your installed coding CLIs as swarm agents. Kimi Code CLI, Claude
 *      Code, Codex and Gemini CLI each get spawned in their own headless print
 *      mode, so work runs on your subscription and your auth.
 *
 * Security posture, deliberately narrow:
 *   - binds 127.0.0.1 only, never a public interface
 *   - every request must carry the pairing token printed at startup
 *   - upstream hosts are allow-listed; anything else is refused
 *   - credential values are never returned to the browser, only their names
 *   - spawning a CLI is OFF until you pass --allow-cli
 *   - nothing is installed, updated or launched without you asking
 *
 * Flags:
 *   --port <n>        default 8787
 *   --token <s>       use a fixed token instead of a random one
 *   --allow-cli       permit spawning local coding CLIs as agents
 *   --allow-sandbox   permit disposable sandboxes that can run commands
 *   --sandbox-root <d>  where sandboxes live (default ~/.swarm-os/sandboxes)
 *   --skills-dir <d>  where SWARM OS writes skills (default ~/.swarm-os/skills)
 *   --allow-host <h>  add one extra upstream host (repeatable)
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const VERSION = "1.0.0";
const HOME = os.homedir();
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const collect = (name) => argv.reduce((acc, v, i) => (v === name && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);

const PORT = Number(flag("--port", 8787));
const TOKEN = flag("--token", crypto.randomBytes(18).toString("base64url"));
const ALLOW_CLI = has("--allow-cli");
const ALLOW_SANDBOX = has("--allow-sandbox");
const SANDBOX_ROOT = path.resolve(flag("--sandbox-root", path.join(HOME, ".swarm-os", "sandboxes")));
const SKILLS_DIR = path.resolve(flag("--skills-dir", path.join(HOME, ".swarm-os", "skills")));

const ALLOWED_HOSTS = new Set([
  "openrouter.ai", "api.z.ai", "open.bigmodel.cn",
  "api.moonshot.ai", "api.kimi.com",
  "api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com",
  "api.deepseek.com", "api.groq.com", "api.mistral.ai", "api.x.ai",
  "api.together.xyz", "api.cerebras.ai", "api.fireworks.ai",
  "api.typesafe.ai",
  "api.tavily.com", "api.exa.ai", "api.firecrawl.dev", "google.serper.dev",
  "api.search.brave.com", "r.jina.ai",
  "127.0.0.1", "localhost"
]);
collect("--allow-host").forEach((h) => ALLOWED_HOSTS.add(h));

/* ------------------------------------------------------------- utilities */
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const redact = (v) => {
  if (!v) return "";
  const s = String(v);
  return s.length <= 10 ? "****" : s.slice(0, 5) + "…" + s.slice(-4);
};
// Enough TOML for the flat "key = value" lines these configs actually use.
function tinyToml(text) {
  const out = {};
  let section = "";
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1]; continue; }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, "");
    out[(section ? section + "." : "") + kv[1]] = v;
  }
  return out;
}
function whichSync(bin) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/* =================================================== CREDENTIAL DISCOVERY
 * Read-only. Values stay in this process; the browser only learns the names.
 */
function discoverCredentials() {
  const found = {};
  const put = (provider, value, source) => {
    if (!value || found[provider]) return;
    found[provider] = { key: String(value).trim(), source };
  };
  const E = process.env;

  put("openrouter", E.OPENROUTER_API_KEY, "env OPENROUTER_API_KEY");
  put("openai", E.OPENAI_API_KEY, "env OPENAI_API_KEY");
  put("anthropic", E.ANTHROPIC_API_KEY, "env ANTHROPIC_API_KEY");
  put("google", E.GEMINI_API_KEY || E.GOOGLE_API_KEY, "env GEMINI_API_KEY");
  put("deepseek", E.DEEPSEEK_API_KEY, "env DEEPSEEK_API_KEY");
  put("groq", E.GROQ_API_KEY, "env GROQ_API_KEY");
  put("mistral", E.MISTRAL_API_KEY, "env MISTRAL_API_KEY");
  put("xai", E.XAI_API_KEY || E.GROK_API_KEY, "env XAI_API_KEY");
  put("together", E.TOGETHER_API_KEY, "env TOGETHER_API_KEY");
  put("cerebras", E.CEREBRAS_API_KEY, "env CEREBRAS_API_KEY");
  put("fireworks", E.FIREWORKS_API_KEY, "env FIREWORKS_API_KEY");
  put("zai", E.ZAI_API_KEY || E.ZHIPUAI_API_KEY || E.GLM_API_KEY || E.Z_AI_API_KEY, "env ZAI_API_KEY");
  put("moonshot", E.MOONSHOT_API_KEY || E.KIMI_API_KEY, "env MOONSHOT_API_KEY");
  put("jev", E.TYPESAFE_API_KEY || E.JEV_API_KEY, "env TYPESAFE_API_KEY");

  // Claude Code. It may be pointed at z.ai or Kimi via ANTHROPIC_BASE_URL, in
  // which case the token belongs to that plan, not to Anthropic.
  const anthBase = E.ANTHROPIC_BASE_URL || "";
  const anthTok = E.ANTHROPIC_AUTH_TOKEN || "";
  if (anthTok) {
    if (anthBase.includes("z.ai") || anthBase.includes("bigmodel")) put("zai", anthTok, "env ANTHROPIC_AUTH_TOKEN pointed at z.ai");
    else if (anthBase.includes("moonshot") || anthBase.includes("kimi")) put("moonshot", anthTok, "env ANTHROPIC_AUTH_TOKEN pointed at Kimi");
    else put("anthropic", anthTok, "env ANTHROPIC_AUTH_TOKEN");
  }
  for (const f of [path.join(HOME, ".claude", "settings.json"), path.join(HOME, ".claude.json"), path.join(HOME, ".config", "claude", "settings.json")]) {
    const j = readJson(f);
    if (!j) continue;
    const env = j.env || {};
    const base = env.ANTHROPIC_BASE_URL || "";
    const tok = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
    if (!tok) continue;
    const where = f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f;
    if (base.includes("z.ai") || base.includes("bigmodel")) put("zai", tok, where);
    else if (base.includes("moonshot") || base.includes("kimi")) put("moonshot", tok, where);
    else put("anthropic", tok, where);
  }

  // Codex
  const codexAuth = readJson(path.join(HOME, ".codex", "auth.json"));
  if (codexAuth) put("openai", codexAuth.OPENAI_API_KEY || codexAuth.openai_api_key || codexAuth.api_key, "~/.codex/auth.json");
  const codexCfg = tinyToml(readText(path.join(HOME, ".codex", "config.toml")));
  Object.keys(codexCfg).forEach((k) => { if (/api_key$/i.test(k)) put("openai", codexCfg[k], "~/.codex/config.toml"); });

  // Kimi Code CLI
  const kimiCfg = tinyToml(readText(path.join(HOME, ".kimi", "config.toml")));
  Object.keys(kimiCfg).forEach((k) => { if (/api_key$/i.test(k)) put("moonshot", kimiCfg[k], "~/.kimi/config.toml"); });
  const kimiJson = readJson(path.join(HOME, ".kimi", "config.json"));
  if (kimiJson) put("moonshot", kimiJson.api_key || kimiJson.apiKey, "~/.kimi/config.json");

  // Gemini CLI
  const gem = readJson(path.join(HOME, ".gemini", "settings.json"));
  if (gem) put("google", gem.apiKey || (gem.security && gem.security.auth && gem.security.auth.apiKey), "~/.gemini/settings.json");

  // z.ai helpers
  const zai = readJson(path.join(HOME, ".z-ai", "config.json")) || readJson(path.join(HOME, ".zai", "config.json"));
  if (zai) put("zai", zai.api_key || zai.apiKey || zai.token, "~/.z-ai/config.json");

  // Search providers
  const search = {};
  const puts = (n, v, s) => { if (v && !search[n]) search[n] = { key: String(v).trim(), source: s }; };
  puts("tavily", E.TAVILY_API_KEY, "env TAVILY_API_KEY");
  puts("exa", E.EXA_API_KEY, "env EXA_API_KEY");
  puts("firecrawl", E.FIRECRAWL_API_KEY, "env FIRECRAWL_API_KEY");
  puts("serper", E.SERPER_API_KEY, "env SERPER_API_KEY");
  puts("brave", E.BRAVE_API_KEY || E.BRAVE_SEARCH_API_KEY, "env BRAVE_API_KEY");

  return { found, search };
}

/* ===================================================== AGENT BEACON
 * Beacon records agent sessions across Claude Code, Cursor, Codex, OpenCode and
 * the rest into one JSONL event log. Reading it is what lets SWARM OS remember
 * what happened in your OTHER harnesses, not just its own chats.
 */
const BEACON_LOG = path.join(HOME, ".beacon", "endpoint", "logs", "runtime.jsonl");
function beaconStatus() {
  const installed = !!whichSync("beacon");
  let events = 0, bytes = 0, newest = null;
  try {
    const st = fs.statSync(BEACON_LOG);
    bytes = st.size; newest = st.mtime.toISOString();
  } catch { /* not installed or never run */ }
  return { installed, logPath: BEACON_LOG.startsWith(HOME) ? "~" + BEACON_LOG.slice(HOME.length) : BEACON_LOG, present: bytes > 0, bytes, newest, events };
}
/* Tail the log without loading a large file into memory. */
function beaconRead(limit, since, query) {
  let raw = "";
  try {
    const fd = fs.openSync(BEACON_LOG, "r");
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);
    raw = buf.toString("utf8");
    if (want < size) raw = raw.slice(raw.indexOf("\n") + 1);   // drop the partial first line
  } catch (e) { return { ok: false, error: "Beacon log not readable: " + e.message } }
  const q = String(query || "").toLowerCase();
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line) } catch { continue }
    if (since && (j.timestamp || j.time || j.ts || "") < since) continue;
    if (q && !JSON.stringify(j).toLowerCase().includes(q)) continue;
    out.push(j);
  }
  return { ok: true, total: out.length, events: out.slice(-(limit || 200)) };
}
/* Append our own runs in the same shape, so SWARM OS work shows up in Beacon's
   dashboard beside every other harness. */
function beaconWrite(events) {
  try {
    fs.mkdirSync(path.dirname(BEACON_LOG), { recursive: true });
    const lines = (events || []).map(e => JSON.stringify(Object.assign({ source: "swarm-os", timestamp: new Date().toISOString() }, e))).join("\n");
    if (lines) fs.appendFileSync(BEACON_LOG, lines + "\n", "utf8");
    return { ok: true, written: (events || []).length };
  } catch (e) { return { ok: false, error: e.message } }
}

/* ========================================================== SANDBOXES
 * The pattern Greptile's TREX popularised: give a review agent its own throwaway
 * computer, let it actually run the change, and return evidence instead of an
 * opinion. This is a local reimplementation of that idea, not an integration
 * with their product.
 *
 * Everything is confined under SANDBOX_ROOT, the whole feature is off until you
 * pass --allow-sandbox, and a small denylist refuses the commands that are only
 * ever destructive.
 */
const SANDBOXES = new Map();
const CMD_DENY = /(^|[;&|\s])(rm\s+-rf\s+\/(?!\w)|mkfs|dd\s+if=|shutdown|reboot|halt|:\(\)\{|chmod\s+-R\s+777\s+\/|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh)/i;
function sandboxPath(id) {
  const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return null;
  const p = path.join(SANDBOX_ROOT, safe);
  const rel = path.relative(SANDBOX_ROOT, p);
  return (rel.startsWith("..") || path.isAbsolute(rel)) ? null : p;
}

/* Local model servers. Detected only — nothing is ever started for you. */
async function detectLocalServers() {
  const out = [];
  const probe = (name, url, provider) =>
    fetch(url, { signal: AbortSignal.timeout(700) })
      .then((r) => { if (r.ok) out.push({ provider, name, url }); })
      .catch(() => {});
  await Promise.all([
    probe("Ollama", "http://127.0.0.1:11434/api/tags", "ollama"),
    probe("LM Studio", "http://127.0.0.1:1234/v1/models", "lmstudio")
  ]);
  return out;
}

/* ================================================== CLI AGENT DEFINITIONS
 * Each entry is a headless invocation of a coding CLI the user already has.
 * argv is a template so a changed flag can be fixed from the app without
 * editing this file.
 */
const CLI_AGENTS = {
  kimi: {
    bin: "kimi", label: "Kimi Code CLI",
    argv: ["-p", "{prompt}", "--output-format", "text", "--yolo"],
    modelFlag: ["-m", "{model}"],
    skillsFlag: ["--skills-dir", "{skills}"],
    note: "Runs on your Kimi coding plan. Ask for sub-agents in the prompt to engage K3 Swarm."
  },
  claude: {
    bin: "claude", label: "Claude Code",
    argv: ["-p", "{prompt}", "--output-format", "text"],
    modelFlag: ["--model", "{model}"],
    note: "Runs on your Claude subscription."
  },
  codex: {
    bin: "codex", label: "Codex CLI",
    argv: ["exec", "{prompt}"],
    modelFlag: ["-m", "{model}"],
    note: "Runs on your OpenAI/ChatGPT plan."
  },
  gemini: {
    bin: "gemini", label: "Gemini CLI",
    argv: ["-p", "{prompt}"],
    modelFlag: ["-m", "{model}"],
    note: "Runs on your Google account."
  },
  bsk: {
    bin: "bsk", label: "BrowserSkill",
    argv: ["{prompt}"],          // the app passes an explicit bsk subcommand line
    raw: true,
    note: "Tencent BrowserSkill. Borrows a tab from your real logged-in browser. Page content is untrusted."
  }
};
function detectClis() {
  return Object.entries(CLI_AGENTS).map(([id, c]) => {
    const bin = whichSync(c.bin);
    return { id, label: c.label, bin: c.bin, path: bin || null, installed: !!bin, note: c.note, argv: c.argv };
  });
}

/* --------------------------------------------------------------- HTTP I/O */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Swarm-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 25 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
const authed = (req) => (req.headers["x-swarm-token"] || "") === TOKEN;

let CREDS = discoverCredentials();
let CLIS = detectClis();
let LOCALS = [];

/* ------------------------------------------------------------------ routes */
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/v1/hello") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    CREDS = discoverCredentials();
    CLIS = detectClis();
    return send(res, 200, {
      ok: true, version: VERSION, node: process.version, platform: process.platform,
      allowCli: ALLOW_CLI, skillsDir: SKILLS_DIR,
      allowSandbox: ALLOW_SANDBOX, sandboxRoot: SANDBOX_ROOT,
      beacon: beaconStatus(),
      // provider ids this bridge can authenticate on the browser's behalf
      providers: Object.keys(CREDS.found),
      searchProviders: Object.keys(CREDS.search),
      // names and sources only. Values never leave this process.
      cli: Object.entries(CREDS.found).map(([p, v]) => ({ provider: p, source: v.source, preview: redact(v.key) })),
      searchCli: Object.entries(CREDS.search).map(([p, v]) => ({ provider: p, source: v.source, preview: redact(v.key) })),
      clis: CLIS, localServers: LOCALS,
      allowed: Array.from(ALLOWED_HOSTS)
    });
  }

  if (url.pathname === "/v1/proxy" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    let payload;
    try { payload = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }
    let target;
    try { target = new URL(payload.target); } catch { return send(res, 400, { ok: false, error: "Bad target URL." }); }
    if (!ALLOWED_HOSTS.has(target.hostname)) {
      return send(res, 403, { ok: false, error: "Host not allow-listed: " + target.hostname + ". Restart with --allow-host " + target.hostname + " if you meant it." });
    }
    const headers = Object.assign({}, payload.headers || {});
    delete headers.host; delete headers.Host; delete headers["content-length"]; delete headers["Content-Length"];

    // Attach a discovered credential here so the browser never holds it.
    const useCred = payload.credential;
    if (useCred && CREDS.found[useCred]) {
      const key = CREDS.found[useCred].key;
      if (useCred === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01"; }
      else headers.Authorization = "Bearer " + key;
    }
    if (payload.searchCredential && CREDS.search[payload.searchCredential]) {
      const key = CREDS.search[payload.searchCredential].key;
      if (payload.searchCredential === "serper") headers["X-API-KEY"] = key;
      else if (payload.searchCredential === "brave") headers["X-Subscription-Token"] = key;
      else if (payload.searchCredential === "exa") headers["x-api-key"] = key;
      else headers.Authorization = "Bearer " + key;
    }

    const lib = target.protocol === "http:" ? http : https;
    const up = lib.request(
      { hostname: target.hostname, port: target.port || (target.protocol === "http:" ? 80 : 443), path: target.pathname + target.search, method: payload.method || "POST", headers },
      (r) => {
        cors(res);
        const h = Object.assign({}, r.headers);
        delete h["content-encoding"]; delete h["content-length"];
        delete h["access-control-allow-origin"];
        res.writeHead(r.statusCode || 502, Object.assign(h, { "Access-Control-Allow-Origin": "*" }));
        r.pipe(res);            // streams straight through, SSE included
      }
    );
    up.on("error", (e) => send(res, 502, { ok: false, error: "Upstream failed: " + e.message }));
    if (payload.body) up.write(typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body));
    up.end();
    return;
  }

  /* Run an installed coding CLI as a swarm agent. Output streams back as JSONL
     so the app can show it arriving. */
  if (url.pathname === "/v1/cli/run" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    if (!ALLOW_CLI) return send(res, 403, { ok: false, error: "CLI spawning is off. Restart the bridge with --allow-cli to enable it." });
    let p;
    try { p = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }
    const def = CLI_AGENTS[p.cli];
    if (!def) return send(res, 400, { ok: false, error: "Unknown CLI: " + p.cli });
    const bin = whichSync(def.bin);
    if (!bin) return send(res, 404, { ok: false, error: def.label + " is not on PATH. Install it, or pick another agent." });

    const prompt = String(p.prompt || "").slice(0, 200000);
    if (!prompt) return send(res, 400, { ok: false, error: "Empty prompt." });

    let args = (Array.isArray(p.argv) && p.argv.length ? p.argv : def.argv).map((a) => a.replace("{prompt}", prompt));
    if (p.model && def.modelFlag) args = args.concat(def.modelFlag.map((a) => a.replace("{model}", p.model)));
    if (p.useSkills && def.skillsFlag && exists(SKILLS_DIR)) args = args.concat(def.skillsFlag.map((a) => a.replace("{skills}", SKILLS_DIR)));

    const cwd = p.cwd && exists(p.cwd) ? p.cwd : process.cwd();
    cors(res);
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
    const line = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* client gone */ } };
    line({ type: "start", cli: p.cli, bin, args: args.map((a) => (a === prompt ? "<prompt>" : a)), cwd });

    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const killTimer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, Math.min(1800, Number(p.timeoutSec) || 600) * 1000);
    child.stdout.on("data", (d) => line({ type: "stdout", text: d.toString() }));
    child.stderr.on("data", (d) => line({ type: "stderr", text: d.toString() }));
    child.on("error", (e) => { line({ type: "error", error: e.message }); });
    child.on("close", (code) => { clearTimeout(killTimer); line({ type: "end", code }); res.end(); });
    req.on("close", () => { clearTimeout(killTimer); try { child.kill("SIGTERM"); } catch {} });
    return;
  }

  /* Write SWARM OS skills to disk so the CLIs can load the same folder with
     --skills-dir. Names are sanitised and confined to SKILLS_DIR. */
  if (url.pathname === "/v1/skills" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    let p;
    try { p = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }
    const written = [];
    const rejected = [];
    for (const s of p.skills || []) {
      const rawName = String(s.name || "");
      if (/[\\/]|\.\./.test(rawName)) { rejected.push({ name: rawName, why: "path separators and .. are not allowed in a skill name" }); continue; }
      const safe = rawName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64);
      if (!safe) { rejected.push({ name: rawName, why: "name has no usable characters" }); continue; }
      const dir = path.join(SKILLS_DIR, safe);
      const file = path.join(dir, "SKILL.md");
      const rel = path.relative(SKILLS_DIR, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;   // no escaping the skills root
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, String(s.content || ""), "utf8");
      written.push(rel);
    }
    return send(res, 200, { ok: true, dir: SKILLS_DIR, written, rejected });
  }
  if (url.pathname === "/v1/skills" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    const out = [];
    try {
      for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = path.join(SKILLS_DIR, d.name, "SKILL.md");
        if (exists(f)) out.push({ name: d.name, content: readText(f).slice(0, 60000) });
      }
    } catch { /* directory may not exist yet */ }
    return send(res, 200, { ok: true, dir: SKILLS_DIR, skills: out });
  }

  /* ---- Agent Beacon ---- */
  if (url.pathname === "/v1/beacon" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    const st = beaconStatus();
    if (!st.present) return send(res, 200, Object.assign({ ok: true, events: [] }, st));
    const r = beaconRead(Number(url.searchParams.get("limit")) || 200, url.searchParams.get("since"), url.searchParams.get("q"));
    return send(res, 200, Object.assign({ ok: true }, st, r));
  }
  if (url.pathname === "/v1/beacon" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    let p; try { p = JSON.parse(await body(req)) } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }) }
    return send(res, 200, beaconWrite(p.events));
  }

  /* ---- sandboxes ---- */
  if (url.pathname === "/v1/sandbox" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
    if (!ALLOW_SANDBOX) return send(res, 403, { ok: false, error: "Sandboxes are off. Restart the bridge with --allow-sandbox to enable them." });
    let p; try { p = JSON.parse(await body(req)) } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }) }

    if (p.op === "create") {
      const id = "sbx_" + crypto.randomBytes(6).toString("hex");
      const dir = sandboxPath(id);
      fs.mkdirSync(dir, { recursive: true });
      let seeded = null;
      if (p.from && exists(p.from)) {
        try { fs.cpSync(p.from, dir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.next|dist|build|target)$/.test(src) }); seeded = p.from }
        catch (e) { return send(res, 500, { ok: false, error: "Could not seed the sandbox: " + e.message }) }
      }
      SANDBOXES.set(id, { id, dir, created: new Date().toISOString(), seeded, runs: 0 });
      return send(res, 200, { ok: true, id, dir, seeded });
    }
    if (p.op === "exec") {
      const sb = SANDBOXES.get(p.id);
      if (!sb) return send(res, 404, { ok: false, error: "No such sandbox." });
      const cmd = String(p.command || "");
      if (!cmd.trim()) return send(res, 400, { ok: false, error: "Empty command." });
      if (CMD_DENY.test(cmd)) return send(res, 403, { ok: false, error: "Refused: that command is on the destructive denylist." });
      sb.runs++;
      const sh = process.platform === "win32" ? "cmd" : "sh";
      const shArgs = process.platform === "win32" ? ["/c", cmd] : ["-lc", cmd];
      const child = spawn(sh, shArgs, { cwd: sb.dir, env: Object.assign({}, process.env, { SWARM_SANDBOX: sb.id }) });
      let out = "", err = "", killed = false;
      const t = setTimeout(() => { killed = true; try { child.kill("SIGKILL") } catch {} }, Math.min(600, Number(p.timeoutSec) || 120) * 1000);
      child.stdout.on("data", d => { if (out.length < 400000) out += d.toString() });
      child.stderr.on("data", d => { if (err.length < 200000) err += d.toString() });
      child.on("close", code => {
        clearTimeout(t);
        send(res, 200, { ok: !killed && code === 0, id: sb.id, exit: code, timedOut: killed, stdout: out.slice(-120000), stderr: err.slice(-40000) });
      });
      child.on("error", e => { clearTimeout(t); send(res, 500, { ok: false, error: e.message }) });
      return;
    }
    if (p.op === "read") {
      const sb = SANDBOXES.get(p.id);
      if (!sb) return send(res, 404, { ok: false, error: "No such sandbox." });
      const target = path.resolve(sb.dir, String(p.path || ""));
      const rel = path.relative(sb.dir, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return send(res, 403, { ok: false, error: "Outside the sandbox." });
      return send(res, 200, { ok: true, path: rel, content: readText(target).slice(0, 200000) });
    }
    if (p.op === "write") {
      const sb = SANDBOXES.get(p.id);
      if (!sb) return send(res, 404, { ok: false, error: "No such sandbox." });
      const target = path.resolve(sb.dir, String(p.path || ""));
      const rel = path.relative(sb.dir, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return send(res, 403, { ok: false, error: "Outside the sandbox." });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(p.content || ""), "utf8");
      return send(res, 200, { ok: true, path: rel, bytes: String(p.content || "").length });
    }
    if (p.op === "destroy") {
      const sb = SANDBOXES.get(p.id);
      if (!sb) return send(res, 404, { ok: false, error: "No such sandbox." });
      try { fs.rmSync(sb.dir, { recursive: true, force: true }) } catch {}
      SANDBOXES.delete(p.id);
      return send(res, 200, { ok: true, destroyed: p.id });
    }
    if (p.op === "list") {
      return send(res, 200, { ok: true, root: SANDBOX_ROOT, sandboxes: Array.from(SANDBOXES.values()).map(x => ({ id: x.id, created: x.created, runs: x.runs, seeded: x.seeded })) });
    }
    return send(res, 400, { ok: false, error: "Unknown sandbox op." });
  }

  send(res, 404, { ok: false, error: "No such route." });
});

detectLocalServers().then((l) => { LOCALS = l; });

server.listen(PORT, "127.0.0.1", () => {
  const creds = Object.keys(CREDS.found);
  const clis = CLIS.filter((c) => c.installed).map((c) => c.label);
  console.log("");
  console.log("  SWARM OS Bridge " + VERSION + "  ->  http://127.0.0.1:" + PORT);
  console.log("  " + "-".repeat(58));
  console.log("  Pairing token :  " + TOKEN);
  console.log("  Credentials   :  " + (creds.length ? creds.join(", ") : "none found"));
  console.log("  Search keys   :  " + (Object.keys(CREDS.search).join(", ") || "none found"));
  console.log("  CLIs on PATH  :  " + (clis.length ? clis.join(", ") : "none found"));
  console.log("  CLI spawning  :  " + (ALLOW_CLI ? "ENABLED" : "off (pass --allow-cli)"));
  console.log("  Sandboxes     :  " + (ALLOW_SANDBOX ? "ENABLED -> " + SANDBOX_ROOT : "off (pass --allow-sandbox)"));
  const bs = beaconStatus();
  console.log("  Agent Beacon  :  " + (bs.present ? bs.logPath + " (" + (bs.bytes / 1024).toFixed(0) + " KB)" : bs.installed ? "installed, no log yet" : "not found"));
  console.log("  Skills dir    :  " + SKILLS_DIR);
  console.log("");
  console.log("  Paste the pairing token into SWARM OS -> Providers -> Bridge.");
  console.log("  Credential values are never sent to the browser.");
  console.log("");
});
