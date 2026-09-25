/*
 * SWARM OS cloud bridge: the bridge for the web app when it is hosted on
 * Vercel. It speaks the same /v1/hello and /v1/proxy protocol as the local
 * bridge (vercel.json rewrites /v1/* here), so the page needs no special case.
 *
 * What it is for, on a phone or any browser:
 *   - reaching providers that refuse browser requests (z.ai, Cerebras, Tavily,
 *     Moonshot's Anthropic surface, TypeSafe);
 *   - keeping API keys in Vercel environment variables instead of on each
 *     device: set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, … and the bridge
 *     attaches them server-side, never sending them to the browser.
 *
 * What it deliberately is not: it cannot run coding CLIs, sandboxes, or see
 * local model servers (that is the Mac app's built-in bridge). It refuses
 * loopback and private addresses outright, only speaks https upstream, only to
 * allow-listed hosts, and every request needs SWARM_BRIDGE_TOKEN.
 */
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const net = require("node:net");

let bridgeLib;
const lib = () => (bridgeLib ||= import("../bridge/swarm-bridge.mjs"));

function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (net.isIP(h) === 4) return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
  if (net.isIP(h) === 6) return h === "::1" || h === "::" || /^(fc|fd|fe80)/.test(h);
  return false;
}

function createCloudHandler(opts = {}) {
  const env = opts.env || process.env;
  const allowLoopback = !!opts.allowLoopbackForTests;   // only the test suite passes this

  return async function handler(req, res) {
    const B = await lib();
    const cors = () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Swarm-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "*");
    };
    const send = (code, obj) => { if (res.headersSent) return res.end(); cors(); res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    if (req.method === "OPTIONS") { cors(); res.statusCode = 204; return res.end(); }

    const url = new URL(req.url, "https://cloud.invalid");
    const route = String(url.searchParams.get("path") || url.pathname.replace(/^\/(api\/bridge|v1)\/?/, "")).replace(/^\/+|\/+$/g, "");

    const TOKEN = env.SWARM_BRIDGE_TOKEN || "";
    if (TOKEN.length < 16) return send(503, { ok: false, error: "The cloud bridge is not set up: add SWARM_BRIDGE_TOKEN (16+ characters) to this Vercel project's environment variables." });
    const got = Buffer.from(String(req.headers["x-swarm-token"] || "")), want = Buffer.from(TOKEN);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(401, { ok: false, error: "Bad or missing access token." });

    const creds = B.discoverCredentials("/nonexistent-home", env);
    const allowed = new Set(B.DEFAULT_ALLOWED_HOSTS.filter((h) => allowLoopback || !isPrivateHost(h)));
    String(env.SWARM_ALLOW_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).forEach((h) => { if (allowLoopback || !isPrivateHost(h)) allowed.add(h); });

    if (route === "hello") {
      return send(200, {
        ok: true, version: B.VERSION, cloud: true, native: false, platform: "vercel",
        allowCli: false, allowSandbox: false,
        providers: Object.keys(creds.found), searchProviders: Object.keys(creds.search),
        cli: Object.entries(creds.found).map(([p, v]) => ({ provider: p, source: "Vercel " + v.source, preview: B.redact(v.key) })),
        searchCli: Object.entries(creds.search).map(([p, v]) => ({ provider: p, source: "Vercel " + v.source, preview: B.redact(v.key) })),
        clis: [], localServers: [], continue: null, beacon: null,
        allowed: Array.from(allowed)
      });
    }

    if (route === "proxy" && req.method === "POST") {
      let payload;
      try {
        const raw = typeof req.body === "string" ? req.body
          : Buffer.isBuffer(req.body) ? req.body.toString("utf8")
          : req.body && typeof req.body === "object" ? JSON.stringify(req.body)
          : await new Promise((resolve, reject) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 25e6) { reject(new Error("too large")); req.destroy(); } }); req.on("end", () => resolve(b)); req.on("error", reject); });
        payload = JSON.parse(raw);
      } catch { return send(400, { ok: false, error: "Body was not JSON." }); }
      let target;
      try { target = new URL(payload.target); } catch { return send(400, { ok: false, error: "Bad target URL." }); }
      if (target.protocol !== "https:" && !(allowLoopback && target.protocol === "http:")) return send(400, { ok: false, error: "The cloud bridge only speaks https." });
      if (!allowLoopback && isPrivateHost(target.hostname)) return send(403, { ok: false, error: "Private and loopback addresses are not reachable from the cloud bridge. Local model servers need the Mac app." });
      if (!allowed.has(target.hostname)) return send(403, { ok: false, error: "Host not allow-listed: " + target.hostname + ". Add it to SWARM_ALLOW_HOSTS in Vercel if you meant it." });

      const headers = Object.assign({}, payload.headers || {});
      for (const k of Object.keys(headers)) if (/^(host|content-length|connection|x-forwarded-.*|x-real-ip)$/i.test(k)) delete headers[k];
      const credFor = (name, table) => {
        if (!name || !table[name]) return {};
        const hosts = B.CREDENTIAL_HOSTS[name] || [];
        if (!hosts.includes(target.hostname)) return { error: "The " + name + " credential is only sent to " + (hosts.join(", ") || "its own provider") + "." };
        return { key: table[name].key };
      };
      const m = credFor(payload.credential, creds.found);
      if (m.error) return send(403, { ok: false, error: m.error });
      if (m.key) {
        if (payload.credential === "anthropic") { headers["x-api-key"] = m.key; headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01"; }
        else headers.Authorization = "Bearer " + m.key;
      }
      const sc = credFor(payload.searchCredential, creds.search);
      if (sc.error) return send(403, { ok: false, error: sc.error });
      if (sc.key) {
        const n = payload.searchCredential;
        if (n === "serper") headers["X-API-KEY"] = sc.key; else if (n === "brave") headers["X-Subscription-Token"] = sc.key; else if (n === "exa") headers["x-api-key"] = sc.key; else headers.Authorization = "Bearer " + sc.key;
      }

      const client = target.protocol === "http:" ? http : https;
      await new Promise((resolve) => {
        const up = client.request({ hostname: target.hostname, port: target.port || (target.protocol === "http:" ? 80 : 443), path: target.pathname + target.search, method: payload.method || "POST", headers }, (r) => {
          cors();
          const h = Object.assign({}, r.headers);
          delete h["content-encoding"]; delete h["content-length"]; delete h["transfer-encoding"]; delete h["connection"]; delete h["access-control-allow-origin"];
          res.writeHead(r.statusCode || 502, Object.assign(h, { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "*", "Cache-Control": "no-store" }));
          r.on("data", (c) => res.write(c));          // streams through, SSE included
          r.on("end", () => { res.end(); resolve(); });
          r.on("error", () => { res.end(); resolve(); });
        });
        up.on("error", (e) => { send(502, { ok: false, error: "Upstream failed: " + e.message }); resolve(); });
        res.on("close", () => { if (!res.writableFinished) up.destroy(); resolve(); });
        if (payload.body) up.write(typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body));
        up.end();
      });
      return;
    }

    return send(404, { ok: false, error: "Not available in the cloud bridge. CLI agents, sandboxes, skills folders and local model servers need the Mac app (or the local bridge)." });
  };
}

module.exports = createCloudHandler();
module.exports.createCloudHandler = createCloudHandler;
module.exports.isPrivateHost = isPrivateHost;
module.exports.config = { maxDuration: 300 };
