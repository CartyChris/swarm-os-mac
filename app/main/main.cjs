/*
 * SWARM OS for Mac — the native shell.
 *
 * What this adds over opening the HTML file in a browser:
 *   - the bridge runs inside the app: no terminal, no token to paste
 *   - your login shell's PATH and environment are picked up, so the CLIs and
 *     API keys your terminal knows about are found (a Finder-launched app
 *     otherwise sees only /usr/bin:/bin:/usr/sbin:/sbin)
 *   - the page lives at a stable http://127.0.0.1 origin, so its IndexedDB
 *     survives restarts and OpenRouter's OAuth redirect has somewhere to land
 *   - CLI agents and sandboxes are switched on and off from the menu bar
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const REPO_URL = "https://github.com/CartyChris/swarm-os-mac";
const DEFAULT_PORT = 17787;
const SMOKE = process.env.SWARM_SMOKE === "1";

const primary = SMOKE || app.requestSingleInstanceLock();
if (!primary) app.quit();

/* ------------------------------------------------------------- settings */
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  const dflt = { allowCli: false, allowSandbox: false, port: DEFAULT_PORT, bounds: null };
  try { return { ...dflt, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { return dflt; }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only disk */ }
}
let settings;

/* ------------------------------------------------------ login-shell env
 * Ask the user's own shell for its environment once, the way a terminal would
 * see it. Bounded by a timeout; on any failure fall back to the usual install
 * locations so Homebrew and npm-global binaries are still found.
 */
function loginShellEnv() {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("ELECTRON_") || k === "NODE_OPTIONS") delete base[k];
  if (process.platform === "win32") return base;
  const home = app.getPath("home");
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".cargo", "bin"), path.join(home, ".volta", "bin")];
  const withExtra = (env) => {
    const parts = (env.PATH || "").split(":").filter(Boolean);
    for (const d of extra) if (!parts.includes(d) && fs.existsSync(d)) parts.push(d);
    return { ...env, PATH: parts.join(":") };
  };
  if (SMOKE) return withExtra(base);
  const shellBin = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const marker = "__SWARM_ENV_" + crypto.randomBytes(4).toString("hex") + "__";
  try {
    const r = spawnSync(shellBin, ["-ilc", `printf '%s' "${marker}"; env -0`], {
      encoding: "utf8", timeout: 6000, env: base, stdio: ["ignore", "pipe", "ignore"]
    });
    const out = String(r.stdout || "");
    const at = out.indexOf(marker);
    if (r.status === 0 && at >= 0) {
      const env = {};
      for (const pair of out.slice(at + marker.length).split("\0")) {
        const i = pair.indexOf("=");
        if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
      }
      if (env.PATH) {
        for (const k of Object.keys(env)) if (k.startsWith("ELECTRON_") || k === "_" || k === "SHLVL" || k === "PWD" || k === "OLDPWD") delete env[k];
        return withExtra({ ...base, ...env });
      }
    }
  } catch { /* fall through */ }
  return withExtra(base);
}

/* ---------------------------------------------------------------- bridge */
let bridge = null, bridgeMod = null, shellEnv = null;
const token = crypto.randomBytes(24).toString("base64url");     // new every launch

function resourcePath(...p) {
  // Packaged: bridge/ and app/renderer are asar-unpacked so Node can import
  // and read them as ordinary files.
  const root = path.join(__dirname, "..", "..");
  return path.join(root.replace(/app\.asar(?=$|[\\/])/, "app.asar.unpacked"), ...p);
}

async function startBridge(port) {
  if (!bridgeMod) bridgeMod = await import(pathToFileURL(resourcePath("bridge", "swarm-bridge.mjs")).href);
  if (!shellEnv) shellEnv = loginShellEnv();
  return bridgeMod.startBridge({
    port, token, env: shellEnv, native: true, quiet: !SMOKE && app.isPackaged,
    allowCli: settings.allowCli, allowSandbox: settings.allowSandbox,
    serveApp: resourcePath("app", "renderer", "swarm-os.html"),
    cwd: app.getPath("home")
  });
}

async function bootBridge() {
  try {
    bridge = await startBridge(settings.port);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    // Another process holds the usual port. A different port is a different
    // origin, so the page's saved data will not be visible this session — say so.
    bridge = await startBridge(0);
    if (!SMOKE) dialog.showMessageBox({
      type: "warning", message: "Port " + settings.port + " is busy",
      detail: "SWARM OS is running on port " + bridge.port + " for this session. Chats and settings saved under the usual port will be back once port " + settings.port + " is free (quit whatever is using it and restart SWARM OS)."
    });
  }
}

async function restartBridge() {
  const port = bridge ? bridge.port : settings.port;
  if (bridge) await bridge.close();
  bridge = await startBridge(port);
  // Let the page see the new switches straight away.
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript("window.SWARM && SWARM.bridgeHello(true).then(() => SWARM.render())").catch(() => {});
}

/* ---------------------------------------------------------------- window */
let win = null;
/* True between leaving for OpenRouter's sign-in and coming back. Signing in
   there can hop through Google, GitHub or an identity provider, so while it
   lasts any https page may load in the window. None of them get the pairing:
   the preload hands it only to the app's own origin. */
let authFlow = false;
const sameOrigin = (u) => { try { return bridge && new URL(u).origin === new URL(bridge.url).origin; } catch { return false; } };
const isOpenRouterAuth = (u) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === "openrouter.ai" && x.pathname.startsWith("/auth"); } catch { return false; } };

function createWindow() {
  const b = settings.bounds || { width: 1440, height: 920 };
  win = new BrowserWindow({
    ...b, minWidth: 860, minHeight: 560, show: false,
    title: "SWARM OS", backgroundColor: "#05070d",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true,
      backgroundThrottling: !SMOKE
    }
  });
  win.once("ready-to-show", () => { if (!SMOKE) win.show(); });

  // Only the app's own origin, and OpenRouter's sign-in page, load in the
  // window. Every other link opens in the default browser.
  const allowed = (url) => {
    if (sameOrigin(url)) { authFlow = false; return true; }
    if (isOpenRouterAuth(url)) { authFlow = true; return true; }
    return authFlow && /^https:/i.test(url);
  };
  win.webContents.on("will-navigate", (e, url) => {
    if (allowed(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on("will-redirect", (e, url) => { if (!allowed(url)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !sameOrigin(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(perm === "clipboard-sanitized-write" || perm === "notifications"));

  let persistTimer = null;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) { settings.bounds = win.getBounds(); saveSettings(); }
    }, 400);
  };
  win.on("resize", persist); win.on("move", persist);
  win.on("closed", () => { win = null; });
  win.loadURL(bridge.url + "/");
}

/* The page's preload asks for the pairing — answered only for our own origin,
   so a page the window is briefly showing (OpenRouter sign-in) never gets it. */
ipcMain.on("swarm:native", (e) => {
  const url = e.senderFrame && e.senderFrame.url;
  e.returnValue = sameOrigin(url || "")
    ? { bridgeUrl: bridge.url, token, platform: process.platform, appVersion: app.getVersion() }
    : null;
});

/* ------------------------------------------------------------------ menu */
async function toggle(key, label, warning) {
  if (!settings[key]) {
    const r = await dialog.showMessageBox(win, {
      type: "warning", buttons: ["Allow", "Cancel"], defaultId: 1, cancelId: 1,
      message: "Allow " + label + "?", detail: warning
    });
    if (r.response !== 0) return buildMenu();
  }
  settings[key] = !settings[key];
  saveSettings();
  await restartBridge();
  buildMenu();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: "SWARM OS",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Allow CLI Agents", type: "checkbox", checked: !!settings.allowCli,
          click: () => toggle("allowCli", "CLI agents", "The swarm will be able to launch the coding CLIs installed on this Mac (Claude Code, Codex, Gemini CLI, Kimi, Continue CLI) with prompts it writes. They run as you, with your subscriptions and your file access. Some run in auto-approve mode.") },
        { label: "Allow Sandboxes", type: "checkbox", checked: !!settings.allowSandbox,
          click: () => toggle("allowSandbox", "sandboxes", "Agents will be able to run shell commands inside throwaway folders under ~/.swarm-os/sandboxes. A denylist blocks the obviously destructive commands, but this is not a security boundary — commands run as you.") },
        { type: "separator" },
        { label: "Open Skills Folder", click: () => { const d = path.join(app.getPath("home"), ".swarm-os", "skills"); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } },
        { label: "Restart Bridge", click: () => restartBridge() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    }] : [{ label: "File", submenu: [{ role: "quit" }] }]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "SWARM OS on GitHub", click: () => shell.openExternal(REPO_URL) },
        { label: "Get Ollama (free local models)", click: () => shell.openExternal("https://ollama.com/download") },
        { label: "Continue CLI", click: () => shell.openExternal("https://docs.continue.dev/guides/cli") }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ----------------------------------------------------------- smoke test
 * SWARM_SMOKE=1 launches headless, waits for the page to boot and pair, runs
 * the app's own selfTest(), prints one JSON line and exits 0 or 1. CI runs
 * this against the packaged .app on a real macOS runner.
 */
async function smoke() {
  const deadline = Date.now() + 60000;
  let r = null;
  while (Date.now() < deadline) {
    r = await win.webContents.executeJavaScript(`(() => {
      const S = window.SWARM; if (!S || !S.state.ready) return null;
      const t = S.selfTest();
      return { ready: true, native: !!S.NATIVE, bridge: S.state.bridge.connected, bridgeNative: !!S.state.bridge.native,
               pass: t.pass, fail: t.fail, failures: t.results.filter(x => !x.pass).map(x => x.name + ": " + x.detail) };
    })()`).catch(() => null);
    if (r) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const ok = !!(r && r.native && r.bridge && r.bridgeNative && r.fail === 0 && r.pass > 40);
  console.log("SWARM_SMOKE " + JSON.stringify({ ok, platform: process.platform, arch: process.arch, electron: process.versions.electron, ...r }));
  await bridge.close();
  app.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------- lifecycle */
app.setName("SWARM OS");
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  if (!primary) return;
  settings = loadSettings();
  nativeTheme.themeSource = "dark";
  app.setAboutPanelOptions({
    applicationName: "SWARM OS", applicationVersion: app.getVersion(),
    credits: "Agentic super harness with a built-in bridge. Local-model support follows Continue (continue.dev, Apache-2.0).",
    website: REPO_URL
  });
  try { await bootBridge(); }
  catch (e) {
    dialog.showErrorBox("SWARM OS could not start its bridge", String(e && e.stack || e));
    app.exit(1); return;
  }
  buildMenu();
  createWindow();
  if (SMOKE) win.webContents.once("did-finish-load", () => { smoke(); });
  app.on("activate", () => { if (!win) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (bridge) bridge.close(); });
