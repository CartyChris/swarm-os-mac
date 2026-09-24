#!/usr/bin/env node
/*
 * The web app carries a copy of the bridge so a browser user can download it
 * from the Bridge page. This keeps that copy identical to bridge/swarm-bridge.mjs.
 *
 *   node scripts/sync-bridge.mjs          rewrite the embedded copy
 *   node scripts/sync-bridge.mjs --check  exit 1 if it is out of date (CI)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "app", "renderer", "swarm-os.html");
const bridgePath = path.join(root, "bridge", "swarm-bridge.mjs");

const html = fs.readFileSync(htmlPath, "utf8");
const bridge = fs.readFileSync(bridgePath, "utf8");
if (/<\/script/i.test(bridge)) {
  console.error("bridge source contains </script and cannot be embedded in a text/plain script block");
  process.exit(1);
}

const open = '<script type="text/plain" id="bridgeSource">';
const start = html.indexOf(open);
const end = html.indexOf("</script>", start);
if (start < 0 || end < 0) { console.error("bridgeSource block not found in " + htmlPath); process.exit(1); }

const next = html.slice(0, start + open.length) + "\n" + bridge + html.slice(end);
if (process.argv.includes("--check")) {
  if (next !== html) { console.error("Embedded bridge is out of date. Run: npm run sync-bridge"); process.exit(1); }
  console.log("Embedded bridge matches bridge/swarm-bridge.mjs");
} else {
  fs.writeFileSync(htmlPath, next);
  console.log(next === html ? "Embedded bridge already current." : "Embedded bridge updated.");
}
