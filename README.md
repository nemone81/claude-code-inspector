# Claude Code Inspector

> Visually pick any DOM element on a webpage, describe what you want changed, and let Claude Code do it.

A Chrome extension paired with a local bridge server that lets you point at any element on any page, write a natural-language prompt, and have [Claude Code](https://docs.claude.com/claude-code) modify your project files in place.

```
┌─────────────────────┐    POST /send    ┌──────────────────┐    Agent SDK    ┌──────────────┐
│  Chrome Extension   │ ───────────────> │   Bridge Server   │ ──────────────> │  Claude Code │
│  (DOM picker, UI)   │ <─────────────── │   (Node.js, SSE)  │ <────────────── │   (CLI/SDK)  │
└─────────────────────┘   SSE: progress  └──────────────────┘    file edits   └──────────────┘
```

## Features

- **Visual DOM picker** — hover and click any element on any page, just like Chrome DevTools' inspector.
- **Rich element context** — tag, CSS selector, classes, dimensions, computed styles, outer HTML, and page URL are sent with every prompt.
- **DevTools-style color picker** — saturation/value square, hue + alpha sliders, hex input, 40-color palette, and an EyeDropper to grab colors directly from the page.
- **Persistent sessions** — Claude Code session is reused across prompts so the model keeps context.
- **Live progress feedback** — Server-Sent Events stream tool usage in real time (Read, Write, Edit, Bash…).
- **In-page completion banner** — a persistent banner with the result and a "Reload without cache" button appears when the task finishes.
- **Clipboard fallback** — when the bridge is offline, the prompt is copied to your clipboard for an interactive Claude Code session.
- **Hot-reload during dev** — `dev-watch.js` reloads the extension on every file change.

## Quick start

### 1. Install Claude Code

This project assumes [Claude Code](https://docs.claude.com/claude-code) is already installed and authenticated on your machine.

### 2. Run the bridge server

```bash
git clone https://github.com/nemone81/claude-code-inspector.git
cd claude-code-inspector/bridge
npm install
node server.js
```

The bridge listens on `http://localhost:3131`.

### 3. Load the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. Pin the extension for quick access.

### 4. Use it

1. Open any webpage (your local dev server, a production site, anything).
2. Click the Claude Code Inspector icon.
3. Click **Select element** and click any element on the page.
4. Open the popup again, set the **Project** path (the local repo Claude should edit) in the settings (⚙).
5. Type a prompt (e.g. *"increase font-size to 18px and add a hover animation"*).
6. Hit **Send to Claude**.

The bridge runs `claude` against your project, streams progress back to the extension, and shows a persistent in-page banner when the task completes.

## Repository layout

```
claude-code-inspector/
├── extension/        Chrome extension (manifest v3)
├── bridge/           Node.js bridge server (Claude Agent SDK)
├── docs/             Architecture, installation, screenshots
├── LICENSE           Apache 2.0
├── NOTICE
├── CONTRIBUTING.md
└── CHANGELOG.md
```

See [docs/architecture.md](docs/architecture.md) for the full data flow and [docs/installation.md](docs/installation.md) for a deeper setup guide.

## Requirements

- macOS, Linux, or Windows (tested primarily on macOS).
- **Node.js ≥ 18** for the bridge server.
- **Chrome / Chromium** with Manifest V3 support.
- Claude Code installed and authenticated.

## Configuration

Configurable via `bridge/.env` (see `bridge/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3131` | Port the bridge listens on |
| `PROJECT_PATH` | `cwd` | Default project the bridge edits when the request omits one |
| `CLAUDE_PATH` | *(unset)* | Override the path to the Claude Code binary if auto-detection fails |

The extension stores the project path and bridge URL in `chrome.storage.local` per-browser.

## Tech stack

- **Extension**: Vanilla JS, Chrome Extension Manifest V3, IBM Plex fonts, no build step.
- **Bridge**: Node.js (zero dependencies beyond the Claude Agent SDK), `http` module, Server-Sent Events.
- **AI runtime**: [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Contributing

Contributions are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Acknowledgements

Built on top of [Claude Code](https://docs.claude.com/claude-code) and the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.
