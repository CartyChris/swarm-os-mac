#!/usr/bin/env node
/*
 * Builds the static web app into public/ for Vercel (or any static host):
 * the single-file app as index.html plus its installable-web-app files.
 * No dependencies; Vercel runs it as the build command.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "app", "renderer");
const out = path.join(root, "public");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "icons"), { recursive: true });
fs.copyFileSync(path.join(src, "swarm-os.html"), path.join(out, "index.html"));
for (const f of ["manifest.webmanifest", "sw.js"]) fs.copyFileSync(path.join(src, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(src, "icons"))) fs.copyFileSync(path.join(src, "icons", f), path.join(out, "icons", f));
console.log("public/ ready: " + fs.readdirSync(out, { recursive: true }).length + " files");
