# Installation guide

## Prerequisites

- **Node.js ≥ 18** — `node -v`
- **Chrome / Chromium** with Manifest V3 support (any recent Chrome works)
- **Claude Code** installed and authenticated — see [the Claude Code docs](https://docs.claude.com/claude-code)

## 1. Clone the repo

```bash
git clone https://github.com/nemone81/claude-code-inspector.git
cd claude-code-inspector
```

## 2. Install and run the bridge

```bash
cd bridge
npm install
cp .env.example .env   # optional, edit if you want defaults
node server.js
```

You should see:

```
╔═══════════════════════════════════════╗
║  Claude Inspector Bridge              ║
║  Agent SDK · Sessions · SSE           ║
╚═══════════════════════════════════════╝

✓ Bridge listening on http://localhost:3131
```

Leave this terminal open — the bridge needs to keep running for the extension to work.

## 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `extension/` folder of the repo.
5. Pin the icon to your toolbar.

## 4. Configure

Click the extension icon → ⚙ (settings):

- **PROJECT** — absolute path of the local repo Claude should edit (e.g. `/Users/you/my-app`).
- **BRIDGE** — defaults to `http://localhost:3131`. Only change if you customized `PORT`.

Click **SAVE CONFIGURATION**.

## 5. Use it

1. Open the page you're working on (your local dev server, a deployed site, anything).
2. Click **Select element** in the popup, then click any element on the page.
3. Type a prompt in the popup and hit **Send to Claude**.
4. Watch the in-page banner for completion. Click **Reload without cache** to refresh the page once Claude finishes.

## Troubleshooting

### Bridge offline · clipboard fallback

The extension can't reach the bridge. Make sure:
- The bridge terminal is still running.
- The bridge URL in settings matches the bridge's actual port.
- No firewall blocks `127.0.0.1:3131`.

### `Claude Code native binary not found`

The Agent SDK couldn't auto-detect the Claude Code binary. Either:
- Reinstall the SDK: `cd bridge && rm -rf node_modules && npm install`
- Or set `CLAUDE_PATH` to your binary, e.g. `CLAUDE_PATH=$(which claude) node server.js`

### `Project directory not found`

The path the extension sent doesn't exist. Make sure the **PROJECT** setting is the absolute, literal path (no `\ ` escapes) of an existing folder.

### Extension doesn't pick up file changes

Run the dev hot-reload server in a second terminal:

```bash
cd extension
node dev-watch.js
```

Now any save in `extension/` reloads the extension automatically.
