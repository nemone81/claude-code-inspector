# Claude Code Inspector + Chrome Companion

> Visually pick any DOM element on a webpage, describe what you want changed, and let Claude Code do it. Plus: identify your Chrome profiles from Claude Code with readable info (email, tabs, alias).

A Chrome extension paired with a local bridge server that lets you point at any element on any page, write a natural-language prompt, and have [Claude Code](https://docs.claude.com/claude-code) modify your project files in place. The **Chrome Companion** feature adds MCP tools that help you identify and disambiguate connected Chrome browser profiles.

```
┌─────────────────────┐    POST /send    ┌──────────────────────────────┐    Agent SDK    ┌──────────────┐
│  Chrome Extension   │ ───────────────> │   Bridge Server              │ ──────────────> │  Claude Code │
│  (DOM picker, UI)   │ <─────────────── │   (Node.js, SSE, MCP stdio)  │ <────────────── │   (CLI/SDK)  │
└─────────────────────┘   SSE: progress  └──────────────────────────────┘    file edits   └──────────────┘
        │                                          ▲
        │    POST /companion/snapshot              │
        └──────────────────────────────────────────┘
              HTTP polling (profile, tabs)
```

https://github.com/user-attachments/assets/dd3f5a25-765a-461b-8628-cedccc59ed74

## Features

### Inspector (original)
- **Visual DOM picker** — hover and click any element on any page, just like Chrome DevTools' inspector.
- **Rich element context** — tag, CSS selector, classes, dimensions, computed styles, outer HTML, and page URL are sent with every prompt.
- **DevTools-style color picker** — saturation/value square, hue + alpha sliders, hex input, 40-color palette, and an EyeDropper to grab colors directly from the page.
- **Persistent sessions** — Claude Code session is reused across prompts so the model keeps context.
- **Live progress feedback** — Server-Sent Events stream tool usage in real time (Read, Write, Edit, Bash…).
- **In-page completion banner** — a persistent banner with the result and a "Reload without cache" button appears when the task finishes.
- **Clipboard fallback** — when the bridge is offline, the prompt is copied to your clipboard for an interactive Claude Code session.

### Chrome Companion (new)
- **`list_my_browsers`** — lists all connected Chrome profiles with email, alias, window/tab counts, and sample tabs.
- **`find_browser`** — finds which profile has a tab matching a URL or title substring (e.g. "localhost", "salesforce").
- **`focus_browser`** — brings a specific Chrome profile's window to the foreground for visual confirmation.
- **Profile bar in popup** — shows the profile email, profileId (click to copy), and connection status.
- **Alias support** — map profileIds to friendly names ("Work", "Personal") via `~/.chrome-companion/aliases.json`.

> **Known limitation:** this companion cannot read the `deviceId` of the official "Claude in Chrome" extension (Chrome extensions are sandboxed from each other). It uses its own `profileId` and serves as a **decision aid + visual confirmation** (via `focus_browser`), not an automatic browser selection.

## Quick start

### 1. Install Claude Code

This project assumes [Claude Code](https://docs.claude.com/claude-code) is already installed and authenticated on your machine.

### 2. Install dependencies

```bash
git clone https://github.com/nemone81/claude-code-inspector.git
cd claude-code-inspector/bridge
npm install
```

### 3. Register the MCP server

```bash
claude mcp add chrome-companion --scope user -- node /path/to/claude-code-inspector/bridge/server.js
```

The bridge will be started automatically by Claude Code as an MCP server. It also listens on `http://localhost:3131` for the extension.

### 4. Load the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. Pin the extension for quick access.
5. **Repeat for each Chrome profile** where you want the companion.

### 5. Use it

**Inspector:**
1. Open any webpage.
2. Click the Claude Code Inspector icon → **Select element** → click any element.
3. Set the **Project** path in settings (⚙).
4. Type a prompt and hit **Send to Claude**.

**Companion:**
Once the extension is installed and the bridge is running, the MCP tools are available in Claude Code:
```
> Which Chrome profiles are connected?
→ list_my_browsers

> Which browser has GitHub open?
→ find_browser "github"

> Bring the work browser to the front
→ focus_browser "4a217738-..."
```

### 6. Configure aliases (optional)

Create `~/.chrome-companion/aliases.json`:

```json
{
  "4a217738-...": "Work",
  "f9e8d7c6-...": "Personal"
}
```

Find your profileId by clicking the truncated ID in the companion bar at the bottom of the extension popup.

## Repository layout

```
claude-code-inspector/
├── extension/        Chrome extension (manifest v3)
├── bridge/           Node.js bridge server (Claude Agent SDK + MCP)
├── docs/             Architecture, installation, screenshots
├── LICENSE           Apache 2.0
├── NOTICE
├── CONTRIBUTING.md
└── CHANGELOG.md
```

See [docs/architecture.md](docs/architecture.md) for the full data flow and [docs/installation.md](docs/installation.md) for a deeper setup guide.

## Requirements

- macOS, Linux, or Windows (tested primarily on macOS).
- **Node.js >= 18** for the bridge server.
- **Chrome / Chromium** with Manifest V3 support.
- Claude Code installed and authenticated.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3131` | Port the bridge listens on |
| `PROJECT_PATH` | `cwd` | Default project the bridge edits when the request omits one |

The extension stores the project path and bridge URL in `chrome.storage.local` per-browser.

## Tech stack

- **Extension**: Vanilla JS, Chrome Extension Manifest V3, IBM Plex fonts, no build step.
- **Bridge**: Node.js, `http` module, Server-Sent Events, MCP stdio server.
- **AI runtime**: [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
- **MCP**: [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

## Contributing

Contributions are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Acknowledgements

Built on top of [Claude Code](https://docs.claude.com/claude-code) and the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.
