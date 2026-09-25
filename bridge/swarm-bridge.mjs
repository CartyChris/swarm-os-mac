#!/usr/bin/env node
/*
 * SWARM OS BRIDGE
 * A small companion for the SWARM OS web app. Zero dependencies, Node 18+.
 *
 *   node swarm-bridge.mjs
 *
 * It does four jobs a web page cannot do for itself:
 *
 *   1. Reaches providers that refuse browser requests. api.z.ai, Cerebras,
 *      Tavily and Moonshot's Anthropic surface all reject cross-origin calls.
 *      This forwards them.
 *   2. Finds the credentials your CLIs already have, and uses them WITHOUT
 *      handing them to the browser. The page asks for "zai"; the key is
 *      attached here and never crosses into the tab. A credential is only ever
 *      attached to its own provider's hosts.
 *   3. Runs your installed coding CLIs as swarm agents. Kimi Code CLI, Claude
 *      Code, Codex, Gemini CLI and Continue CLI each get spawned in their own
 *      headless print mode, so work runs on your subscription and your auth.
 *   4. Reads your Continue setup. Models and keys you configured in
 *      ~/.continue/config.yaml become swarm agents, and every local model server
 *      Continue knows how to talk to (Ollama, LM Studio, llama.cpp, Msty,
 *      Lemonade, Jan, Docker Model Runner, text-generation-webui) is detected —
 *      the zero-cost, no-quota route.
 *
 * Security posture, deliberately narrow:
 *   - binds 127.0.0.1 only, never a public interface
 *   - every API request must carry the pairing token printed at startup
 *   - the Host header must name this loopback listener (DNS-rebinding guard)
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
 *   --serve-app <f>   also serve this HTML file at / (same origin as the API)
 *
 * Embedding (the macOS app does this):
 *   import { startBridge } from "./swarm-bridge.mjs";
 *   const b = await startBridge({ port, token, allowCli, env });
 *   ...; await b.close();
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "1.1.0";

const DEFAULT_ALLOWED_HOSTS = [
  "openrouter.ai", "api.z.ai", "open.bigmodel.cn",
  "api.moonshot.ai", "api.kimi.com",
  "api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com",
  "api.deepseek.com", "api.groq.com", "api.mistral.ai", "api.x.ai",
  "api.together.xyz", "api.cerebras.ai", "api.fireworks.ai",
  "api.typesafe.ai",
  "api.tavily.com", "api.exa.ai", "api.firecrawl.dev", "google.serper.dev",
  "api.search.brave.com", "r.jina.ai",
  "127.0.0.1", "localhost"
];

/* Which hosts each credential may be sent to. A key found for one provider is
   never attached to a request bound for another, even an allow-listed one. */
export const CREDENTIAL_HOSTS = {
  openrouter: ["openrouter.ai"],
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  deepseek: ["api.deepseek.com"],
  groq: ["api.groq.com"],
  mistral: ["api.mistral.ai"],
  xai: ["api.x.ai"],
  together: ["api.together.xyz"],
  cerebras: ["api.cerebras.ai"],
  fireworks: ["api.fireworks.ai"],
  zai: ["api.z.ai", "open.bigmodel.cn"],
  moonshot: ["api.moonshot.ai", "api.kimi.com"],
  jev: ["api.typesafe.ai"],
  tavily: ["api.tavily.com"],
  exa: ["api.exa.ai"],
  firecrawl: ["api.firecrawl.dev"],
  serper: ["google.serper.dev"],
  brave: ["api.search.brave.com"]
};

/* ------------------------------------------------------------- utilities */
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
export const redact = (v) => {
  if (!v) return "";
  const s = String(v);
  return s.length <= 10 ? "****" : s.slice(0, 5) + "…" + s.slice(-4);
};
/* Substitute a {placeholder} literally. String.prototype.replace with a string
   argument would expand "$&", "$'" and friends inside the user's prompt. */
export const fill = (template, key, value) => String(template).split("{" + key + "}").join(String(value));

// Enough TOML for the flat "key = value" lines these configs actually use.
export function tinyToml(text) {
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

/* Enough YAML for a Continue config.yaml: block maps, block lists, inline
   [a, b] lists, quoted and plain scalars, comments. Anchors, multi-line
   scalars and flow maps are skipped rather than guessed at. */
export function tinyYaml(text) {
  const lines = [];
  for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
    const noComment = stripYamlComment(raw);
    if (!noComment.trim() || noComment.trim() === "---") continue;
    lines.push({ indent: noComment.match(/^ */)[0].length, text: noComment.trim() });
  }
  let i = 0;
  const isItem = (t) => t === "-" || t.startsWith("- ");
  function scalar(s) {
    s = s.trim();
    if (s === "" || s === "~" || s === "null") return null;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== null);
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }
  function block(indent) {
    if (i >= lines.length) return null;
    return isItem(lines[i].text) ? list(lines[i].indent) : map(indent);
  }
  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
      const m = lines[i].text.match(/^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/);
      i++;
      if (!m) continue;
      const key = String(scalar(m[1]));
      const rest = m[2];
      if (rest !== undefined && rest !== "") { out[key] = scalar(rest); continue; }
      if (i < lines.length && lines[i].indent > indent) out[key] = block(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) out[key] = list(indent);
      else out[key] = null;
    }
    return out;
  }
  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
      const after = lines[i].text.slice(1).trimStart();
      if (!after) { i++; out.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null); continue; }
      if (!after.startsWith("[") && /^("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:(\s|$)/.test(after)) {
        // "- key: value" opens a map whose further keys sit one column past the dash.
        const childIndent = indent + (lines[i].text.length - after.length);
        lines[i] = { indent: childIndent, text: after };
        out.push(map(childIndent));
      } else {
        out.push(scalar(after));
        i++;
      }
    }
    return out;
  }
  return lines.length ? block(lines[0].indent) : null;
}
function stripYamlComment(line) {
  let q = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (k === 0 || /\s/.test(line[k - 1]))) return line.slice(0, k).replace(/\s+$/, "");
  }
  return line.replace(/\s+$/, "");
}
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text || "").split("\n")) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function makeWhich(env) {
  return function whichSync(bin) {
    const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const dir of (env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const p = path.join(dir, bin + ext);
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
      }
    }
    return null;
  };
}

/* ========================================================== CONTINUE
 * Continue (continue.dev) keeps its models in ~/.continue/config.yaml (or the
 * legacy config.json), with secrets in ~/.continue/.env. Mapping those onto
 * SWARM OS providers means a model you already set up there is one click away
 * here — and its key, like every other, stays inside this process.
 */
export const CONTINUE_PROVIDER_MAP = {
  openai: "openai", anthropic: "anthropic", gemini: "google", mistral: "mistral",
  deepseek: "deepseek", groq: "groq", xai: "xai", together: "together",
  cerebras: "cerebras", fireworks: "fireworks", openrouter: "openrouter",
  moonshot: "moonshot", zai: "zai",
  ollama: "ollama", lmstudio: "lmstudio", "llama.cpp": "llamacpp", llamacpp: "llamacpp",
  llamafile: "llamacpp", msty: "msty", lemonade: "lemonade", docker: "docker_models",
  "text-gen-webui": "textgenwebui", jan: "jan"
};
export function discoverContinue(home, env) {
  const dir = env.CONTINUE_GLOBAL_DIR || path.join(home, ".continue");
  const secrets = parseDotEnv(readText(path.join(dir, ".env")));
  const resolve = (v) => {
    if (typeof v !== "string") return v ?? null;
    const m = v.match(/^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/);
    if (!m) return v.includes("${{") ? null : v;
    return secrets[m[1]] || env[m[1]] || null;
  };
  let cfg = null, file = null;
  for (const name of ["config.yaml", "config.yml", "config.json"]) {
    const f = path.join(dir, name);
    if (!exists(f)) continue;
    try { cfg = name.endsWith(".json") ? readJson(f) : tinyYaml(readText(f)); } catch { cfg = null; }
    file = f;
    if (cfg) break;
  }
  const models = [], hubRefs = [], keys = [];
  if (cfg && Array.isArray(cfg.models)) {
    for (const m of cfg.models) {
      if (!m || typeof m !== "object") continue;
      if (m.uses) { hubRefs.push(String(m.uses)); continue; }
      const cProvider = String(m.provider || "").toLowerCase();
      const swarm = CONTINUE_PROVIDER_MAP[cProvider] || null;
      const key = resolve(m.apiKey);
      const apiBase = resolve(m.apiBase);
      if (key && swarm && CREDENTIAL_HOSTS[swarm]) {
        // A custom apiBase means the key belongs to some other endpoint; only
        // adopt it for the provider when it points at that provider's own host.
        let ok = !apiBase;
        if (apiBase) { try { ok = CREDENTIAL_HOSTS[swarm].includes(new URL(apiBase).hostname); } catch { ok = false; } }
        if (ok) keys.push({ provider: swarm, key });
      }
      models.push({
        name: String(m.title || m.name || m.model || "model"),
        provider: cProvider, swarmProvider: swarm, model: String(m.model || ""),
        apiBase: apiBase || null, roles: Array.isArray(m.roles) ? m.roles : [], hasKey: !!key
      });
    }
  }
  const where = file ? (file.startsWith(home) ? "~" + file.slice(home.length) : file) : null;
  return { present: !!cfg, file: where, models, hubRefs, keys };
}

/* =================================================== CREDENTIAL DISCOVERY
 * Read-only. Values stay in this process; the browser only learns the names.
 */
export function discoverCredentials(home, env) {
  const found = {};
  const put = (provider, value, source) => {
    if (!value || found[provider]) return;
    found[provider] = { key: String(value).trim(), source };
  };
  const E = env;

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
  for (const f of [path.join(home, ".claude", "settings.json"), path.join(home, ".claude.json"), path.join(home, ".config", "claude", "settings.json")]) {
    const j = readJson(f);
    if (!j) continue;
    const cenv = j.env || {};
    const base = cenv.ANTHROPIC_BASE_URL || "";
    const tok = cenv.ANTHROPIC_AUTH_TOKEN || cenv.ANTHROPIC_API_KEY || "";
    if (!tok) continue;
    const where = f.startsWith(home) ? "~" + f.slice(home.length) : f;
    if (base.includes("z.ai") || base.includes("bigmodel")) put("zai", tok, where);
    else if (base.includes("moonshot") || base.includes("kimi")) put("moonshot", tok, where);
    else put("anthropic", tok, where);
  }

  // Codex
  const codexAuth = readJson(path.join(home, ".codex", "auth.json"));
  if (codexAuth) put("openai", codexAuth.OPENAI_API_KEY || codexAuth.openai_api_key || codexAuth.api_key, "~/.codex/auth.json");
  const codexCfg = tinyToml(readText(path.join(home, ".codex", "config.toml")));
  Object.keys(codexCfg).forEach((k) => { if (/api_key$/i.test(k)) put("openai", codexCfg[k], "~/.codex/config.toml"); });

  // Kimi Code CLI
  const kimiCfg = tinyToml(readText(path.join(home, ".kimi", "config.toml")));
  Object.keys(kimiCfg).forEach((k) => { if (/api_key$/i.test(k)) put("moonshot", kimiCfg[k], "~/.kimi/config.toml"); });
  const kimiJson = readJson(path.join(home, ".kimi", "config.json"));
  if (kimiJson) put("moonshot", kimiJson.api_key || kimiJson.apiKey, "~/.kimi/config.json");

  // Gemini CLI
  const gem = readJson(path.join(home, ".gemini", "settings.json"));
  if (gem) put("google", gem.apiKey || (gem.security && gem.security.auth && gem.security.auth.apiKey), "~/.gemini/settings.json");

  // z.ai helpers
  const zai = readJson(path.join(home, ".z-ai", "config.json")) || readJson(path.join(home, ".zai", "config.json"));
  if (zai) put("zai", zai.api_key || zai.apiKey || zai.token, "~/.z-ai/config.json");

  // Continue — last, so a dedicated CLI's own credential wins a tie.
  const cont = discoverContinue(home, env);
  for (const k of cont.keys) put(k.provider, k.key, cont.file || "~/.continue");

  // Search providers
  const search = {};
  const puts = (n, v, s) => { if (v && !search[n]) search[n] = { key: String(v).trim(), source: s }; };
  puts("tavily", E.TAVILY_API_KEY, "env TAVILY_API_KEY");
  puts("exa", E.EXA_API_KEY, "env EXA_API_KEY");
  puts("firecrawl", E.FIRECRAWL_API_KEY, "env FIRECRAWL_API_KEY");
  puts("serper", E.SERPER_API_KEY, "env SERPER_API_KEY");
  puts("brave", E.BRAVE_API_KEY || E.BRAVE_SEARCH_API_KEY, "env BRAVE_API_KEY");

  return { found, search, continue: cont };
}

/* ========================================================== LOCAL SERVERS
 * Every local runtime Continue ships a provider for, at its default port.
 * Detected only — nothing is ever started for you. Local inference has no
 * per-token price and no quota: this is the genuinely unlimited free route.
 * Every probe must answer with a model list, so an unrelated dev server on a
 * generic port (5000, 8000, 8080) is not mistaken for one.
 */
export const LOCAL_SERVERS = [
  { provider: "ollama", name: "Ollama", base: "http://127.0.0.1:11434/v1", probe: "http://127.0.0.1:11434/api/tags" },
  { provider: "lmstudio", name: "LM Studio", base: "http://127.0.0.1:1234/v1", probe: "http://127.0.0.1:1234/v1/models" },
  { provider: "llamacpp", name: "llama.cpp / Llamafile", base: "http://127.0.0.1:8080/v1", probe: "http://127.0.0.1:8080/v1/models" },
  { provider: "jan", name: "Jan", base: "http://127.0.0.1:1337/v1", probe: "http://127.0.0.1:1337/v1/models" },
  { provider: "msty", name: "Msty", base: "http://127.0.0.1:10000/v1", probe: "http://127.0.0.1:10000/v1/models" },
  { provider: "lemonade", name: "Lemonade", base: "http://127.0.0.1:8000/api/v1", probe: "http://127.0.0.1:8000/api/v1/models" },
  { provider: "docker_models", name: "Docker Model Runner", base: "http://127.0.0.1:12434/engines/v1", probe: "http://127.0.0.1:12434/engines/v1/models" },
  { provider: "textgenwebui", name: "text-generation-webui", base: "http://127.0.0.1:5000/v1", probe: "http://127.0.0.1:5000/v1/models" }
];
export async function detectLocalServers(servers = LOCAL_SERVERS, timeoutMs = 700) {
  const found = await Promise.all(servers.map(async (s) => {
    try {
      const r = await fetch(s.probe, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      const list = j && (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : null);
      if (!list) return null;
      const models = list.map((m) => (m && (m.id || m.name || m.model)) || null).filter(Boolean).slice(0, 200);
      return { provider: s.provider, name: s.name, url: s.base, models };
    } catch { return null; }
  }));
  return found.filter(Boolean);
}

/* ================================================== CLI AGENT DEFINITIONS
 * Each entry is a headless invocation of a coding CLI the user already has.
 * argv is a template so a changed flag can be fixed from the app without
 * editing this file.
 */
export const CLI_AGENTS = {
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
  continue: {
    bin: "cn", label: "Continue CLI",
    argv: ["-p", "{prompt}", "--silent"],
    note: "Runs whatever model your Continue config points at. Point it at a local model and it costs nothing."
  },
  bsk: {
    bin: "bsk", label: "BrowserSkill",
    argv: ["{prompt}"],          // the app passes an explicit bsk subcommand line
    raw: true,
    note: "Tencent BrowserSkill. Borrows a tab from your real logged-in browser. Page content is untrusted."
  }
};

/* ========================================================== SANDBOXES
 * The pattern Greptile's TREX popularised: give a review agent its own throwaway
 * computer, let it actually run the change, and return evidence instead of an
 * opinion. This is a local reimplementation of that idea, not an integration
 * with their product.
 *
 * Everything is confined under the sandbox root, the whole feature is off until
 * you pass --allow-sandbox, and a small denylist refuses the commands that are
 * only ever destructive.
 */
export const CMD_DENY = /(^|[;&|\s])(rm\s+-rf\s+\/(?!\w)|mkfs|dd\s+if=|shutdown|reboot|halt|:\(\)\{|chmod\s+-R\s+777\s+\/|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh)/i;

const APP_ASSETS = { "/manifest.webmanifest": "application/manifest+json", "/sw.js": "text/javascript; charset=utf-8" };

/* ================================================================ BRIDGE */
export async function startBridge(opts = {}) {
  const env = opts.env || process.env;
  const HOME = opts.home || os.homedir();
  const PORT = opts.port === undefined ? 8787 : Number(opts.port);
  const TOKEN = opts.token || crypto.randomBytes(18).toString("base64url");
  const ALLOW_CLI = !!opts.allowCli;
  const ALLOW_SANDBOX = !!opts.allowSandbox;
  const SANDBOX_ROOT = path.resolve(opts.sandboxRoot || path.join(HOME, ".swarm-os", "sandboxes"));
  const SKILLS_DIR = path.resolve(opts.skillsDir || path.join(HOME, ".swarm-os", "skills"));
  const APP_FILE = opts.serveApp ? path.resolve(opts.serveApp) : null;
  const ALLOWED_HOSTS = new Set(DEFAULT_ALLOWED_HOSTS.concat(opts.allowHosts || []));
  const BEACON_LOG = path.join(HOME, ".beacon", "endpoint", "logs", "runtime.jsonl");
  const whichSync = makeWhich(env);
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  /* ---------------------------------------------------- AGENT BEACON
   * Beacon records agent sessions across Claude Code, Cursor, Codex, OpenCode
   * and the rest into one JSONL event log. Reading it is what lets SWARM OS
   * remember what happened in your OTHER harnesses, not just its own chats.
   */
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
    } catch (e) { return { ok: false, error: "Beacon log not readable: " + e.message }; }
    const q = String(query || "").toLowerCase();
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (since && (j.timestamp || j.time || j.ts || "") < since) continue;
      if (q && !JSON.stringify(j).toLowerCase().includes(q)) continue;
      out.push(j);
    }
    return { ok: true, total: out.length, events: out.slice(-(limit || 200)) };
  }
  /* Append our own runs in the same shape, so SWARM OS work shows up in
     Beacon's dashboard beside every other harness. */
  function beaconWrite(events) {
    try {
      fs.mkdirSync(path.dirname(BEACON_LOG), { recursive: true });
      const lines = (events || []).map((e) => JSON.stringify(Object.assign({ source: "swarm-os", timestamp: new Date().toISOString() }, e))).join("\n");
      if (lines) fs.appendFileSync(BEACON_LOG, lines + "\n", "utf8");
      return { ok: true, written: (events || []).length };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  const SANDBOXES = new Map();
  function sandboxPath(id) {
    const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) return null;
    const p = path.join(SANDBOX_ROOT, safe);
    const rel = path.relative(SANDBOX_ROOT, p);
    return (rel.startsWith("..") || path.isAbsolute(rel)) ? null : p;
  }

  function detectClis() {
    return Object.entries(CLI_AGENTS).map(([id, c]) => {
      const bin = whichSync(c.bin);
      return { id, label: c.label, bin: c.bin, path: bin || null, installed: !!bin, note: c.note, argv: c.argv };
    });
  }

  /* ------------------------------------------------------------- HTTP I/O */
  function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Swarm-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  function send(res, code, obj) {
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
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
  const tokenBuf = Buffer.from(TOKEN);
  const authed = (req) => {
    const got = Buffer.from(String(req.headers["x-swarm-token"] || ""));
    return got.length === tokenBuf.length && crypto.timingSafeEqual(got, tokenBuf);
  };
  let boundPort = PORT;
  /* A page on some other site can make the browser resolve its own hostname to
     127.0.0.1. Refusing any Host that is not this listener closes that door. */
  const hostOk = (req) => {
    const h = String(req.headers.host || "").toLowerCase();
    return h === "127.0.0.1:" + boundPort || h === "localhost:" + boundPort;
  };

  let CREDS = discoverCredentials(HOME, env);
  let CLIS = detectClis();
  let LOCALS = [];
  let localsAt = 0;
  async function refreshLocals(force) {
    if (!force && Date.now() - localsAt < 5000) return LOCALS;
    LOCALS = await (opts.detectLocalServers || detectLocalServers)();
    localsAt = Date.now();
    return LOCALS;
  }

  function hello() {
    const cont = CREDS.continue;
    return {
      ok: true, version: VERSION, node: process.version, platform: process.platform,
      native: !!opts.native,
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
      // apiBase can itself come from a secret, so the page only learns whether one is set.
      continue: {
        present: cont.present, file: cont.file, hubRefs: cont.hubRefs,
        models: cont.models.map(({ apiBase, ...m }) => ({ ...m, customApiBase: !!apiBase }))
      },
      allowed: Array.from(ALLOWED_HOSTS)
    };
  }

  /* ---------------------------------------------------------------- routes */
  const server = http.createServer(async (req, res) => {
    if (!hostOk(req)) { res.writeHead(421, { "Content-Type": "text/plain" }); return res.end("Misdirected request."); }
    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    const url = new URL(req.url, "http://127.0.0.1");

    /* The app itself. Served from the same loopback origin so the page has a
       stable http:// home (IndexedDB persists, OpenRouter's OAuth redirect has
       somewhere to land). It contains no secrets; the token is not in it. */
    if (APP_FILE && req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = readText(APP_FILE);
      if (!html) return send(res, 500, { ok: false, error: "App file missing: " + APP_FILE });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer"
      });
      return res.end(html);
    }
    /* The app's installable-web-app files, from the same folder. A fixed list,
       so nothing else beside the app is reachable. */
    if (APP_FILE && req.method === "GET" && (APP_ASSETS[url.pathname] || /^\/icons\/[a-z0-9-]+\.png$/.test(url.pathname))) {
      const file = path.join(path.dirname(APP_FILE), url.pathname.slice(1));
      if (path.relative(path.dirname(APP_FILE), file).startsWith("..")) return send(res, 404, { ok: false, error: "No such route." });
      let data;
      try { data = fs.readFileSync(file); } catch { return send(res, 404, { ok: false, error: "No such file." }); }
      res.writeHead(200, { "Content-Type": APP_ASSETS[url.pathname] || "image/png", "Cache-Control": url.pathname === "/sw.js" ? "no-cache" : "public, max-age=3600" });
      return res.end(data);
    }

    if (url.pathname === "/v1/hello") {
      if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
      CREDS = discoverCredentials(HOME, env);
      CLIS = detectClis();
      await refreshLocals(url.searchParams.get("rescan") === "1");
      return send(res, 200, hello());
    }

    if (url.pathname === "/v1/proxy" && req.method === "POST") {
      if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
      let payload;
      try { payload = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }
      let target;
      try { target = new URL(payload.target); } catch { return send(res, 400, { ok: false, error: "Bad target URL." }); }
      if (target.protocol !== "https:" && target.protocol !== "http:") return send(res, 400, { ok: false, error: "Only http and https targets." });
      if (!ALLOWED_HOSTS.has(target.hostname)) {
        return send(res, 403, { ok: false, error: "Host not allow-listed: " + target.hostname + ". Restart with --allow-host " + target.hostname + " if you meant it." });
      }
      const headers = Object.assign({}, payload.headers || {});
      delete headers.host; delete headers.Host; delete headers["content-length"]; delete headers["Content-Length"];

      // Attach a discovered credential here so the browser never holds it —
      // and only when the request is going to that credential's own provider.
      const credFor = (name, table) => {
        if (!name || !table[name]) return {};
        const hosts = CREDENTIAL_HOSTS[name] || [];
        if (!hosts.includes(target.hostname)) {
          return { error: "The " + name + " credential is only sent to " + (hosts.join(", ") || "its own provider") + ", not " + target.hostname + "." };
        }
        return { key: table[name].key };
      };
      const model = credFor(payload.credential, CREDS.found);
      if (model.error) return send(res, 403, { ok: false, error: model.error });
      if (model.key) {
        if (payload.credential === "anthropic") { headers["x-api-key"] = model.key; headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01"; }
        else headers.Authorization = "Bearer " + model.key;
      }
      const search = credFor(payload.searchCredential, CREDS.search);
      if (search.error) return send(res, 403, { ok: false, error: search.error });
      if (search.key) {
        const sc = payload.searchCredential;
        if (sc === "serper") headers["X-API-KEY"] = search.key;
        else if (sc === "brave") headers["X-Subscription-Token"] = search.key;
        else if (sc === "exa") headers["x-api-key"] = search.key;
        else headers.Authorization = "Bearer " + search.key;
      }

      const lib = target.protocol === "http:" ? http : https;
      const up = lib.request(
        { hostname: target.hostname, port: target.port || (target.protocol === "http:" ? 80 : 443), path: target.pathname + target.search, method: payload.method || "POST", headers },
        (r) => {
          cors(res);
          const h = Object.assign({}, r.headers);
          delete h["content-encoding"]; delete h["content-length"];
          delete h["access-control-allow-origin"];
          // Expose-Headers lets the page read upstream headers such as Mcp-Session-Id.
          res.writeHead(r.statusCode || 502, Object.assign(h, { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "*" }));
          r.pipe(res);            // streams straight through, SSE included
        }
      );
      up.on("error", (e) => send(res, 502, { ok: false, error: "Upstream failed: " + e.message }));
      // Stop the upstream call when the page aborts (the Stop button).
      res.on("close", () => { if (!res.writableFinished) up.destroy(); });
      if (payload.body) up.write(typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body));
      up.end();
      return;
    }

    /* Run an installed coding CLI as a swarm agent. Output streams back as
       JSONL so the app can show it arriving. */
    if (url.pathname === "/v1/cli/run" && req.method === "POST") {
      if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
      if (!ALLOW_CLI) return send(res, 403, { ok: false, error: opts.native ? "CLI agents are off. Turn them on from the menu bar: SWARM OS → Allow CLI Agents." : "CLI spawning is off. Restart the bridge with --allow-cli to enable it." });
      let p;
      try { p = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }
      const def = CLI_AGENTS[p.cli];
      if (!def) return send(res, 400, { ok: false, error: "Unknown CLI: " + p.cli });
      const bin = whichSync(def.bin);
      if (!bin) return send(res, 404, { ok: false, error: def.label + " is not on PATH. Install it, or pick another agent." });

      const prompt = String(p.prompt || "").slice(0, 200000);
      if (!prompt) return send(res, 400, { ok: false, error: "Empty prompt." });

      let args = (Array.isArray(p.argv) && p.argv.length ? p.argv : def.argv).map((a) => fill(a, "prompt", prompt));
      if (p.model && def.modelFlag) args = args.concat(def.modelFlag.map((a) => fill(a, "model", p.model)));
      if (p.useSkills && def.skillsFlag && exists(SKILLS_DIR)) args = args.concat(def.skillsFlag.map((a) => fill(a, "skills", SKILLS_DIR)));

      const cwd = p.cwd && exists(p.cwd) ? p.cwd : (opts.cwd || process.cwd());
      cors(res);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const line = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* client gone */ } };
      line({ type: "start", cli: p.cli, bin, args: args.map((a) => (a === prompt ? "<prompt>" : a)), cwd });

      const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const killTimer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, Math.min(1800, Number(p.timeoutSec) || 600) * 1000);
      child.stdout.on("data", (d) => line({ type: "stdout", text: d.toString() }));
      child.stderr.on("data", (d) => line({ type: "stderr", text: d.toString() }));
      child.on("error", (e) => { line({ type: "error", error: e.message }); });
      child.on("close", (code) => { clearTimeout(killTimer); line({ type: "end", code }); res.end(); });
      // The client going away (Stop, or a closed window) ends the agent too.
      res.on("close", () => { clearTimeout(killTimer); if (child.exitCode === null) { try { child.kill("SIGTERM"); } catch { /* gone */ } } });
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
      let p; try { p = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }
      return send(res, 200, beaconWrite(p.events));
    }

    /* ---- sandboxes ---- */
    if (url.pathname === "/v1/sandbox" && req.method === "POST") {
      if (!authed(req)) return send(res, 401, { ok: false, error: "Bad or missing pairing token." });
      if (!ALLOW_SANDBOX) return send(res, 403, { ok: false, error: opts.native ? "Sandboxes are off. Turn them on from the menu bar: SWARM OS → Allow Sandboxes." : "Sandboxes are off. Restart the bridge with --allow-sandbox to enable them." });
      let p; try { p = JSON.parse(await body(req)); } catch { return send(res, 400, { ok: false, error: "Body was not JSON." }); }

      if (p.op === "create") {
        const id = "sbx_" + crypto.randomBytes(6).toString("hex");
        const dir = sandboxPath(id);
        fs.mkdirSync(dir, { recursive: true });
        let seeded = null;
        if (p.from && exists(p.from)) {
          try { fs.cpSync(p.from, dir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.next|dist|build|target)$/.test(src) }); seeded = p.from; }
          catch (e) { return send(res, 500, { ok: false, error: "Could not seed the sandbox: " + e.message }); }
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
        const child = spawn(sh, shArgs, { cwd: sb.dir, env: Object.assign({}, env, { SWARM_SANDBOX: sb.id }) });
        let out = "", err = "", killed = false, done = false;
        const t = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, Math.min(600, Number(p.timeoutSec) || 120) * 1000);
        child.stdout.on("data", (d) => { if (out.length < 400000) out += d.toString(); });
        child.stderr.on("data", (d) => { if (err.length < 200000) err += d.toString(); });
        child.on("close", (code) => {
          clearTimeout(t);
          if (done) return; done = true;
          send(res, 200, { ok: !killed && code === 0, id: sb.id, exit: code, timedOut: killed, stdout: out.slice(-120000), stderr: err.slice(-40000) });
        });
        child.on("error", (e) => { clearTimeout(t); if (done) return; done = true; send(res, 500, { ok: false, error: e.message }); });
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
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return send(res, 403, { ok: false, error: "Outside the sandbox." });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(p.content || ""), "utf8");
        return send(res, 200, { ok: true, path: rel, bytes: String(p.content || "").length });
      }
      if (p.op === "destroy") {
        const sb = SANDBOXES.get(p.id);
        if (!sb) return send(res, 404, { ok: false, error: "No such sandbox." });
        try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch { /* already gone */ }
        SANDBOXES.delete(p.id);
        return send(res, 200, { ok: true, destroyed: p.id });
      }
      if (p.op === "list") {
        return send(res, 200, { ok: true, root: SANDBOX_ROOT, sandboxes: Array.from(SANDBOXES.values()).map((x) => ({ id: x.id, created: x.created, runs: x.runs, seeded: x.seeded })) });
      }
      return send(res, 400, { ok: false, error: "Unknown sandbox op." });
    }

    send(res, 404, { ok: false, error: "No such route." });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  boundPort = server.address().port;
  refreshLocals(true).catch(() => {});

  const creds = Object.keys(CREDS.found);
  const clis = CLIS.filter((c) => c.installed).map((c) => c.label);
  const bs = beaconStatus();
  log("");
  log("  SWARM OS Bridge " + VERSION + "  ->  http://127.0.0.1:" + boundPort);
  log("  " + "-".repeat(58));
  log("  Pairing token :  " + TOKEN);
  log("  Credentials   :  " + (creds.length ? creds.join(", ") : "none found"));
  log("  Search keys   :  " + (Object.keys(CREDS.search).join(", ") || "none found"));
  log("  Continue      :  " + (CREDS.continue.present ? CREDS.continue.file + " (" + CREDS.continue.models.length + " model(s))" : "no ~/.continue config"));
  log("  CLIs on PATH  :  " + (clis.length ? clis.join(", ") : "none found"));
  log("  CLI spawning  :  " + (ALLOW_CLI ? "ENABLED" : "off (pass --allow-cli)"));
  log("  Sandboxes     :  " + (ALLOW_SANDBOX ? "ENABLED -> " + SANDBOX_ROOT : "off (pass --allow-sandbox)"));
  log("  Agent Beacon  :  " + (bs.present ? bs.logPath + " (" + (bs.bytes / 1024).toFixed(0) + " KB)" : bs.installed ? "installed, no log yet" : "not found"));
  log("  Skills dir    :  " + SKILLS_DIR);
  if (APP_FILE) log("  App           :  http://127.0.0.1:" + boundPort + "/");
  log("");
  log("  Paste the pairing token into SWARM OS -> Providers -> Bridge.");
  log("  Credential values are never sent to the browser.");
  log("");

  return {
    port: boundPort, token: TOKEN, url: "http://127.0.0.1:" + boundPort, server,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

/* ------------------------------------------------------------------- CLI */
const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  const has = (name) => argv.includes(name);
  const collect = (name) => argv.reduce((acc, v, i) => (v === name && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);
  startBridge({
    port: Number(flag("--port", 8787)),
    token: flag("--token", undefined),
    allowCli: has("--allow-cli"),
    allowSandbox: has("--allow-sandbox"),
    sandboxRoot: flag("--sandbox-root", undefined),
    skillsDir: flag("--skills-dir", undefined),
    allowHosts: collect("--allow-host"),
    serveApp: flag("--serve-app", undefined)
  }).catch((e) => {
    console.error("  SWARM OS Bridge could not start: " + (e.code === "EADDRINUSE" ? "port already in use. Pass --port <n>." : e.message));
    process.exit(1);
  });
}
