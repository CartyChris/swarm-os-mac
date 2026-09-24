# SWARM OS for Mac

SWARM OS, the agentic super harness, as a native macOS app. One orchestrator model you talk to, which calls other models as tools to build a swarm, with a Definition of Done enforced on every run. This app adds:

- **The bridge, built in.** There's no terminal and no pairing token to paste. The app starts the bridge on `127.0.0.1` and pairs with it on every launch.
- **Free AI that is actually unlimited: local models.** Any local runtime [Continue](https://github.com/continuedev/continue) supports is detected at its default port: Ollama, LM Studio, llama.cpp/Llamafile, Jan, Msty, Lemonade, Docker Model Runner, and text-generation-webui. **Free mode** keeps every call at $0.
- **Your Continue setup, reused.** Models and keys in `~/.continue/config.yaml` (secrets in `~/.continue/.env`) show up as swarm agents. The Continue CLI (`cn`) can run as a CLI agent.
- **Your terminal's world.** A Finder-launched app normally sees a bare `PATH`. This one reads your login shell's environment, so the `claude`, `codex`, `gemini`, `kimi` and `cn` CLIs and the API keys your terminal knows about are all found.

## What "free" means here, and what it doesn't

Continue doesn't provide unlimited free AI. Its hosted free trial has fixed chat and autocomplete caps. What Continue does provide is excellent support for **local models**, and that is the route this app builds on:

| Route | Cost | Limits |
|---|---|---|
| Local model server (Ollama, LM Studio, …) | $0 | None. Limited only by your Mac's hardware |
| OpenRouter models ending in `:free`, or priced at $0 | $0 | Needs a free OpenRouter key. OpenRouter sets daily and per-minute limits |
| CLI agents (Claude Code, Codex, Gemini CLI, Kimi) | Your existing subscription | That subscription's limits. Free mode does not count these as free |
| Continue CLI (`cn`) | Whatever model your Continue config selects | Free when that model is local |

With **Free mode** on, a single choke point that every model call passes through (`callModel`) enforces three rules:

- A request for a metered model is swapped for the best free model you can reach, and the swap is logged.
- With no free model reachable, the call is refused. It is never sent to a paid provider.
- Fallbacks only move between free models.

Jev, OpenRouter's paid web plugin and paid search APIs are switched off in Free mode. On first launch with no paid keys and a local server running, the app starts in Free mode automatically.

### Quickest free setup

```sh
brew install ollama
ollama serve &
ollama pull qwen2.5-coder:7b
```

Open SWARM OS. It finds Ollama, turns Free mode on, and points every model slot at the local model. The **Free AI** view shows what was found.

## Install

Download the `.dmg` for your Mac (Apple Silicon `arm64` or Intel `x64`). Look under **Releases**, or under the latest run's artifacts in **Actions**.

Builds made without an Apple Developer certificate are ad-hoc signed, so macOS asks once. Either right-click the app, choose **Open**, then **Open** again, or run:

```sh
xattr -dr com.apple.quarantine "/Applications/SWARM OS.app"
```

To ship signed and notarized builds, add the `MAC_CERTS`, `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets to the repository. CI uses them when they are present.

## Menu bar

**SWARM OS → Allow CLI Agents** and **Allow Sandboxes** are off by default. Each one asks for confirmation before it turns on, and changing either restarts the built-in bridge. **Help** links to Ollama and the Continue CLI.

## Security model

- The bridge listens on `127.0.0.1` only, and every API call needs this launch's random token.
- The bridge rejects any request whose `Host` header doesn't name the loopback listener, which blocks DNS rebinding.
- The token reaches the page through a preload script. The preload answers only the app's own origin, so the OpenRouter sign-in page shown in the window never gets it.
- Credential values never reach the page. The page learns only provider names and redacted previews.
- A credential is only ever attached to requests for **its own provider's hosts**. An OpenAI key can't be sent to another host, even an allow-listed one.
- Only the app's origin and OpenRouter's sign-in page load in the window. Every other link opens in your browser.
- Nothing is installed, pulled or started for you.

## Running in a browser instead

The bridge is still a standalone, zero-dependency Node script:

```sh
node bridge/swarm-bridge.mjs --allow-cli --serve-app app/renderer/swarm-os.html
# then open http://127.0.0.1:8787/ and paste the printed token in Bridge & CLIs
```

The Bridge page in the app can also download the same script. The copy embedded in the HTML is kept identical to `bridge/swarm-bridge.mjs`: run `npm run sync-bridge` to update it, and CI fails if the two drift.

## Develop

```sh
npm ci
npm start                 # run the app from source
npm test                  # bridge unit tests + embedded-bridge sync check
npm run test:e2e          # real Chromium: fake local Ollama, free mode, the app's selfTest()
npm run test:electron     # launch Electron headless, require the page to pair and selfTest() to pass
npm run dist:mac          # build .dmg/.zip (on a Mac)
npm run icon              # re-render build/icon.png from its SVG source
```

```
app/main/main.cjs          Electron main: login-shell env, built-in bridge, window, menu, smoke mode
app/main/preload.cjs       hands the page its bridge pairing (own origin only)
app/renderer/swarm-os.html the SWARM OS harness (single file)
bridge/swarm-bridge.mjs    the bridge: proxy, credential discovery, CLI agents, Continue, local servers
test/                      node:test suites and the Electron smoke runner
```

## Changes from the original bridge and harness

The first commit in this repository is the harness and bridge exactly as provided, so `git diff` against it shows every change. Beyond the features above:

- **Fixed:** prompts sent to CLI agents went through `String.replace`, so `$&`, `$'` and similar sequences were rewritten. A prompt `costs $'5 and $& more` reached the CLI as `costs 5 and {prompt} more`.
- **Fixed:** local model servers were probed only once, at bridge start. Starting Ollama later was never noticed. `/v1/hello` now re-probes (rate-limited), and the app checks again every 20 s.
- **Fixed:** a discovered credential could be attached to any allow-listed host. It is now bound to its provider's hosts.
- **Hardened:** a Host-header check, a constant-time token comparison, and an upstream request that is cancelled when the page stops a run.
- Local providers only show as ready when the bridge actually found them running.

## Acknowledgements

Local-runtime default ports and the `config.yaml`/`.env` layout follow [Continue](https://github.com/continuedev/continue) (Apache-2.0). No Continue source code is included. The Continue CLI is used only if you have installed it.
