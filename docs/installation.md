# Installation guide

## Prerequisites

- **Node.js ≥ 18** — `node -v`
- **Chrome ≥ 116** (side panel + WebSocket service-worker keepalive)
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
║  Claude Inspector Bridge v4           ║
║  Agent SDK · Warm sessions · WS       ║
╚═══════════════════════════════════════╝

✓ Bridge listening on http://localhost:3131

🔑 Auth token (paste it in the extension side panel):
   <token>
```

Copy the token — you'll need it in step 4. Leave this terminal open.

## 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `extension/` folder of the repo.
5. Pin the icon to your toolbar.

## 4. Configure

Click the extension icon — the side panel opens. Open ⚙ (settings):

- **Project path** — absolute path of the local repo Claude should edit (e.g. `/Users/you/my-app`). Used whenever the inspected page does not name a project itself (see below).
- **Bridge URL** — defaults to `http://localhost:3131`. Only change if you customized `PORT`.
- **Auth token** — paste the token the bridge printed at startup.

Click **Save**. The status dot in the header turns green when the WebSocket connects.

### Letting the page name its project

Retyping that path on every project switch gets old fast. A page can name its own project:

```html
<meta name="claude-inspector-project" content="my-app">
```

The panel picks it up from the active tab and it wins over the ⚙ field while you are on that page. It is a **name**, not a path: whoever serves the page writes that tag — production included — so the bridge resolves it under roots you declare locally and refuses anything outside them (`..`, symlinks leaving a root, and the root itself). Declare them once:

```json
// ~/.claude-inspector/config.json
{ "roots": ["~/Projects"] }
```

or with `INSPECTOR_PROJECT_ROOTS=/Users/you/Projects`. The file is reread on every request. With no roots declared, pages cannot choose the project at all.

## 5. Use it

1. Open the page you're working on (ideally your local dev server).
2. Click **Select element** (or **Multi-select**), then click element(s) on the page.
3. Choose **Edit** or **Explain** mode; optionally enable **Verify after edit**.
4. Type a prompt and hit **Send to Claude**.
5. Follow progress in the panel's activity log; a banner appears on the tab when done. Use **View diff** / **Undo task** if needed.

## 6. (Optional) MCP tool for the terminal

```bash
claude mcp add inspector -- node /abs/path/to/claude-code-inspector/bridge/mcp-server.js
```

Then in a terminal Claude Code session: *"look at the element I selected in the browser"*.

## Troubleshooting

### `bridge up · set token` / `bad token`

The bridge is reachable but the token is missing or wrong. Paste the token printed at bridge startup into ⚙ settings. To rotate it, delete `bridge/.inspector_token` and restart the bridge.

### Bridge offline

The extension can't reach the bridge. Make sure:
- The bridge terminal is still running.
- The bridge URL in settings matches the bridge's actual port.
- No firewall blocks `127.0.0.1:3131`.

### `Claude Code native binary not found`

The Agent SDK couldn't auto-detect the Claude Code binary. Either:
- Reinstall the SDK: `cd bridge && rm -rf node_modules && npm install`
- Or set `CLAUDE_PATH` to your binary, e.g. `CLAUDE_PATH=$(which claude) node server.js`

### `Project directory not found`

The path the extension sent doesn't exist. Make sure the **Project path** setting is the absolute, literal path (no `\ ` escapes) of an existing folder.

### `progetto "…" non trovato nelle root consentite`

The page names a project the bridge will not resolve: either the folder is not under a declared root, or no roots are declared. Add them to `~/.claude-inspector/config.json` (`{"roots": ["~/Projects"]}`) — no restart needed.

### Screenshots or verification fail on non-localhost pages

Default host permissions cover only `localhost`/`127.0.0.1`. Grant the optional `<all_urls>` permission from `chrome://extensions` → Claude Code Inspector → *Site access*.

### Extension doesn't pick up file changes

Run the dev hot-reload server in a second terminal:

```bash
cd extension
node dev-watch.js
```

Now any save in `extension/` reloads the extension automatically.
