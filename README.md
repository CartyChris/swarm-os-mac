# SWARM OS

SWARM OS is an agentic super harness. You talk to one orchestrator model, and it calls other models as tools to build a swarm. Every run gets an enforced Definition of Done. You can use it three ways:

- **The Mac app.** The bridge is built in, and local models are free and unlimited.
- **On the web, from any phone or laptop.** Deploy it to Vercel. It installs to the home screen and includes an optional cloud bridge.
- **As a single HTML file in a browser**, next to the standalone bridge script.

## What it does

### Live artifacts: watch the swarm build

When the swarm writes an app, a game, a web page, a React component, a Mermaid diagram, SVG, a Markdown document, CSV or JSON, the result streams into the **Artifact panel** and renders while it is still being written. It works like Claude's artifacts:

- **Live from every source.** This covers the orchestrator's reply, every agent in a swarm, and `create_artifact` tool calls. Tool calls are read from their JSON arguments as they stream.
- **Sandboxed previews.** A running game is not reloaded by the chat re-rendering around it. The preview runs in a sandbox that cannot reach the app's storage, where your API keys live. It still gets a working `localStorage` and keyboard focus.
- **Versions.** A revision of `snake.html` becomes version 2 of the same file, and you can switch between versions. If the preview throws an error, **Ask the swarm to fix it** sends the error back.
- **Cards in chat.** Chat shows a card instead of a wall of code. Each artifact offers Preview/Code, copy, download, PNG snapshot, full screen and a resizable panel.

### Chat, the way Open WebUI does it

- **Chats drawer.** Search titles and message text; pin, rename, archive and delete chats. Export a chat as Markdown, JSON or a standalone web page you can share. Import chats (Open WebUI exports too). Temporary chats are never stored.
- **Message actions.** Edit and resend; regenerate, with every earlier answer kept as a version; continue; read aloud; 👍/👎; delete. Follow-up suggestions appear after each reply.
- **Dictation.** Uses the browser's speech recognition; in the Mac app, macOS Dictation. Math renders with KaTeX. JavaScript and Python code blocks get a **▶ Run** button, running in a sandbox (Python via Pyodide).
- **Library.** Model presets: a base model plus its own instructions, usable anywhere a model is chosen. A prompt library that appears when you type `/`, with `{{CURRENT_DATE}}`, `{{CLIPBOARD}}` and other variables. A personal leaderboard built from your ratings.

### Free AI, honestly

Continue (continue.dev) does not provide unlimited free AI; its hosted trial has fixed caps. What it does support well is **local models**, and SWARM OS builds on the same runtimes at the same default ports: Ollama, LM Studio, llama.cpp/Llamafile, Jan, Msty, Lemonade, Docker Model Runner and text-generation-webui.

| Route | Cost | Limits |
|---|---|---|
| Local model server (Mac app or local bridge) | $0 | None beyond your hardware |
| OpenRouter models ending in `:free`, or priced at $0 | $0 | Needs a free OpenRouter key; OpenRouter sets daily and per-minute limits |
| CLI agents (Claude Code, Codex, Gemini CLI, Kimi, Continue CLI) | Your existing subscription | That subscription's limits |

**Free mode** is enforced in `callModel`, the one function every model call passes through:

- A request for a metered model is swapped for the best free model you can reach.
- If nothing free is reachable, the call is refused. It is never sent to a paid provider.
- Fallbacks only move between free models.
- Jev, OpenRouter's paid web plugin and paid search APIs are switched off.

Quickest start on a Mac:

```sh
brew install ollama && ollama serve & ollama pull qwen2.5-coder:7b
```

On a phone, sign in with OpenRouter and turn free mode on.

### From Agent-OS Forge 5 and RTBT Forge

- **MCP tool servers** (streamable HTTP). Their tools join the orchestrator's and every agent's toolset. Calls need your approval unless you mark the server trusted. There is a tool scratchpad for calling tools by hand.
- **Web source policy.** Allow or block domains, with presets. Each run gets an **evidence ledger** showing what was found, read and cited.
- **Judge panel.** Up to five judges per verdict; the median score and the majority decide.
- **Artifact tools for agents.** `read_artifact` and `preview_artifact` let agents revise an app and show it to you.
- **Request preview and diagnostics.** See the exact request as cURL, and run a health check of the browser.
- **Design Studio additions.** Button styles and shapes, wallpapers, textures, phone navigation modes and large tap targets.
- **Security and ops lanes.** All 59 were already present from RTBT, in the Ops Deck.

## The Mac app

Download the `.dmg` for your Mac (Apple Silicon `arm64` or Intel `x64`) from **Releases**, or from the latest run's artifacts in **Actions**. Builds without an Apple Developer certificate are ad-hoc signed, so macOS asks once. Right-click → **Open**, or run:

```sh
xattr -dr com.apple.quarantine "/Applications/SWARM OS.app"
```

- **Terminal environment.** The app reads your login shell's environment, so it finds the `claude`, `codex`, `gemini`, `kimi` and `cn` CLIs and the API keys your terminal knows about.
- **Your Continue setup.** Models and keys in `~/.continue/config.yaml` (with secrets in `~/.continue/.env`) become swarm agents.
- **Menu switches.** **SWARM OS → Allow CLI Agents** and **Allow Sandboxes** are off by default, and each asks before turning on.

To ship signed and notarized builds, add these repository secrets: `MAC_CERTS`, `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.

## On the web (Vercel)

`vercel.json` builds `public/` with a zero-dependency script and serves the app as an installable web app (manifest, service worker, home-screen icons). Every push to `main` redeploys.

On a phone, open the site and choose **Share → Add to Home Screen** (iOS) or **Install app** (Android).

### Cloud bridge (optional)

`api/bridge.js` speaks the same protocol as the local bridge, at `/v1/*`. It serves two purposes:

- It reaches providers that refuse browser requests: z.ai, Cerebras, Tavily, Moonshot's Anthropic surface and TypeSafe.
- It lets you keep API keys in Vercel instead of on each device. Set `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and so on in **Project → Settings → Environment Variables**. The bridge attaches them server-side and never sends them to the browser.

To use it:

1. Set `SWARM_BRIDGE_TOKEN` (16+ random characters) in the Vercel project.
2. On each device, open **Bridge & CLIs** and pair: the URL is the site itself, and the token is that value.

The cloud bridge only speaks https, only to allow-listed hosts, and refuses loopback and private addresses. Extend the list with `SWARM_ALLOW_HOSTS=host1,host2`. It cannot run CLIs or reach model servers on your computer; that is what the Mac app is for.

Without the cloud bridge, the web app still works fully with browser-reachable providers (OpenRouter, Anthropic, OpenAI, Gemini, Groq, Mistral, xAI, Together, DeepSeek, Moonshot), using keys stored in that browser.

## Security model

- **Local bridge.** Listens on `127.0.0.1` only. Every request needs a random token, and a Host-header check blocks DNS rebinding. In the Mac app, the token reaches only the app's own origin, through the preload script.
- **Credentials.** Values never reach the page. A credential is only ever attached to requests for its own provider's hosts.
- **Isolation.** Artifact previews and the code runner run in iframes without `allow-same-origin`, so they cannot read the app's storage. Artifacts are never opened as same-origin pages.
- **Approvals.** MCP tool calls and flagged agent tools wait for your approval. The approval bar shows in every layout.

## Develop

```sh
npm ci
npm start                 # the Mac app from source
npm test                  # bridge + cloud bridge unit tests, embedded-bridge sync check
npm run test:e2e          # Chromium end to end: fake Ollama and MCP servers, live artifacts, chat features
npm run test:cdn          # KaTeX, Pyodide, Mermaid, React previews (needs internet; runs in CI)
npm run test:electron     # the real Electron app, headless: pairs natively, selfTest() must pass
npm run build:web         # public/ for any static host
npm run dist:mac          # .dmg/.zip (on a Mac)
npm run icon              # re-render all icons from their SVG source
```

```
app/main/            Electron main process and preload
app/renderer/        the SWARM OS harness (single HTML file) + web-app manifest, service worker, icons
bridge/              the local bridge: proxy, credential discovery, CLI agents, Continue, local servers
api/bridge.js        the cloud bridge (Vercel function)
scripts/             web build, icon renderer, embedded-bridge sync
test/                node:test suites and the Electron smoke runner
```

The first commit is the harness and bridge exactly as provided, so `git diff` against it shows every change.

## Acknowledgements

Local-runtime default ports and the `config.yaml`/`.env` layout follow [Continue](https://github.com/continuedev/continue) (Apache-2.0). No Continue source code is included. Features were ported from the author's Agent-OS Forge 5 and RTBT Forge harnesses, and modelled on [Open WebUI](https://github.com/open-webui/open-webui)'s chat experience (reimplemented, not copied).
