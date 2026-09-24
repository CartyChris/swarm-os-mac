#!/usr/bin/env node
/*
 * Launch the real Electron app in smoke mode and require a passing report.
 *
 *   node test/electron.smoke.mjs                      the dev tree (npx electron .)
 *   node test/electron.smoke.mjs "<path to binary>"   a packaged app, e.g.
 *     "dist/mac-arm64/SWARM OS.app/Contents/MacOS/SWARM OS"
 *
 * On Linux it needs a display (run under xvfb-run) and, as root, --no-sandbox.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packaged = process.argv[2];
const bin = packaged || createRequire(import.meta.url)("electron");
const args = packaged ? [] : [root];
if (process.platform === "linux" && ((process.getuid && process.getuid() === 0) || process.env.SMOKE_NO_SANDBOX)) args.push("--no-sandbox");

// A throwaway profile, so the smoke run never touches (or is shaped by) real app data.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-smoke-profile-"));
args.push("--user-data-dir=" + profile);

const child = spawn(bin, args, { env: { ...process.env, SWARM_SMOKE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(d); });
const timer = setTimeout(() => { console.error("smoke: timed out"); child.kill("SIGKILL"); }, 120000);
child.on("close", (code) => {
  clearTimeout(timer);
  fs.rmSync(profile, { recursive: true, force: true });
  const line = out.split("\n").find((l) => l.startsWith("SWARM_SMOKE "));
  if (!line) { console.error("smoke: no report line (exit " + code + ")"); process.exit(1); }
  const r = JSON.parse(line.slice("SWARM_SMOKE ".length));
  if (!r.ok || code !== 0) { console.error("smoke: FAILED", r); process.exit(1); }
  console.log(`smoke: OK — ${r.platform}/${r.arch}, Electron ${r.electron}, bridge paired natively, selfTest ${r.pass} passed / ${r.fail} failed`);
});
