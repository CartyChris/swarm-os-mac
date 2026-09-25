import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCloudHandler, isPrivateHost } = require("../api/bridge.js");
const env = { SWARM_BRIDGE_TOKEN: "t".repeat(24), OPENROUTER_API_KEY: "sk-or-v1-secretsecretsecret", TAVILY_API_KEY: "tvly-secretsecret" };

const servers = [];
async function serve(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return "http://127.0.0.1:" + s.address().port;
}
let strict, loose, upstream, upSeen = [];
before(async () => {
  strict = await serve(createCloudHandler({ env }));
  loose = await serve(createCloudHandler({ env, allowLoopbackForTests: true }));
  upstream = await serve((req, res) => {
    upSeen.push({ auth: req.headers.authorization || null, xff: req.headers["x-forwarded-for"] || null });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: one\n\n"); setTimeout(() => res.end("data: two\n\n"), 30);
  });
});
after(() => servers.forEach((s) => s.close()));

const call = (base, p, init = {}, token = env.SWARM_BRIDGE_TOKEN) => fetch(base + p, { ...init, headers: { "X-Swarm-Token": token, "Content-Type": "application/json", ...(init.headers || {}) } });

test("private and loopback hosts are recognised", () => {
  for (const h of ["localhost", "127.0.0.1", "10.0.0.8", "192.168.1.2", "172.16.0.1", "169.254.169.254", "100.64.0.1", "[::1]", "fd00::1", "metadata.internal"]) assert.equal(isPrivateHost(h), true, h);
  for (const h of ["api.openai.com", "8.8.8.8", "172.32.0.1", "openrouter.ai"]) assert.equal(isPrivateHost(h), false, h);
});

test("refuses to run without a configured token, and with a wrong one", async () => {
  const unset = await serve(createCloudHandler({ env: {} }));
  assert.equal((await call(unset, "/v1/hello")).status, 503);
  assert.equal((await call(strict, "/v1/hello", {}, "wrong")).status, 401);
  assert.equal((await fetch(strict + "/v1/hello")).status, 401);
});

test("hello names the env credentials without their values", async () => {
  const r = await call(strict, "/api/bridge?path=hello");
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!text.includes("secretsecret"), "key value leaked");
  const j = JSON.parse(text);
  assert.equal(j.cloud, true); assert.equal(j.allowCli, false);
  assert.deepEqual(j.providers, ["openrouter"]); assert.deepEqual(j.searchProviders, ["tavily"]);
  assert.ok(!j.allowed.includes("127.0.0.1") && !j.allowed.includes("localhost"));
});

test("loopback, private, plain-http and unlisted targets are refused", async () => {
  const post = (target) => call(strict, "/v1/proxy", { method: "POST", body: JSON.stringify({ target }) });
  assert.equal((await post("https://127.0.0.1/x")).status, 403);
  assert.equal((await post("https://169.254.169.254/latest/meta-data")).status, 403);
  assert.equal((await post("http://api.openai.com/v1/models")).status, 400);
  assert.equal((await post("https://example.com/")).status, 403);
});

test("a credential is only attached for its own provider's host", async () => {
  const r = await call(strict, "/v1/proxy", { method: "POST", body: JSON.stringify({ target: "https://api.openai.com/v1/models", credential: "openrouter" }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /only sent to openrouter\.ai/);
});

test("proxies and streams through, dropping forwarding headers", async () => {
  upSeen = [];
  const r = await call(loose, "/v1/proxy", { method: "POST", body: JSON.stringify({ target: upstream + "/sse", method: "GET", headers: { "X-Forwarded-For": "1.2.3.4" } }) });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "data: one\n\ndata: two\n\n");
  assert.deepEqual(upSeen, [{ auth: null, xff: null }]);
});

test("routes the Mac app has and the cloud does not are a clear 404", async () => {
  const r = await call(strict, "/v1/cli/run", { method: "POST", body: "{}" });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /need the Mac app/);
});
