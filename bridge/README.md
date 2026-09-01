# Bridge

Local Node.js server that bridges the Chrome extension to the Claude Agent SDK. Keeps one **warm SDK process per (project, mode)**, queues tasks per project, and pushes events to the extension over **WebSocket**.

## Run

```bash
npm install
node server.js            # or: node cli.js --port 3131 --project /abs/path
```

Listens on `http://localhost:3131` by default and prints the **auth token** at startup. Every endpoint (and the WebSocket) requires it via `Authorization: Bearer <token>`, `X-Inspector-Token: <token>` or `?token=`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `WS`   | `/ws?token=…` | Event stream (`task_start`, `task_progress`, `task_done`, `verify_start`, `verify_done`, `session_reset`) + element-capture channel |
| `POST` | `/send`     | Submit a prompt: `{ prompt, projectPath \| project, mode: "edit"\|"explain", tabId, verify, elements, images }` |
| `GET`  | `/diff?taskId=` | Git diff of the files a task modified |
| `POST` | `/undo`     | `{ taskId }` — stash the task's changes (recover with `git stash pop`) |
| `POST` | `/reset`    | Clear session(s): `{ projectPath }` for one project, empty body for all |
| `GET`  | `/session`  | Inspect warm sessions |
| `GET`  | `/selected` | Last element(s) selected in the browser (used by the MCP server) |
| `GET`  | `/project/resolve?project=` | Where a page-declared project lands on this machine, or why it was refused |
| `GET`  | `/browsers` | Connected Chrome profiles: alias, email, window/tab counts, sample tabs |
| `GET`  | `/browsers/find?q=` | Find which browser has a tab matching a URL/title substring |
| `POST` | `/browsers/:id/focus` | Bring a browser profile to the foreground (round-trip with the extension) |
| `GET`  | `/health`   | Liveness; without a token returns only `{ status, version }` |

## MCP server

`mcp-server.js` is a dependency-free MCP stdio server. Register it once:

```bash
claude mcp add inspector -- node /abs/path/to/bridge/mcp-server.js
```

Tools:

- `get_selected_element` — the element(s) currently selected in the extension (selector, styles, HTML, source file/line on dev builds).
- `list_my_browsers` — connected Chrome profiles with email, alias, tab counts, sample tabs.
- `find_browser` — which browser has a tab matching a URL/title substring.
- `focus_browser` — bring a profile's window to the foreground.

It uses the same token file and `INSPECTOR_BRIDGE_URL` (default `http://127.0.0.1:3131`).

## Companion

Every Chrome profile running the extension announces itself over the WS: a stable profile id, the profile email, and the window/tab list. Snapshots are sent **only when something changed** (a light ping keeps the profile alive in between); URLs of sensitive domains (password managers, payment providers, Google accounts — configurable via the `sensitiveDomains` key in the extension's storage) are redacted. Profiles disappear after ~2 min of silence or when their WS drops. Human-readable aliases live in `~/.chrome-companion/aliases.json` (`{ "profileId": "name" }`, hot-reloaded).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3131` | Port to listen on |
| `PROJECT_PATH` | `cwd` | Default project path used when a request omits one |
| `INSPECTOR_PROJECT_ROOTS` | *(unset)* | `:`-separated roots under which a page may name its project (overrides `~/.claude-inspector/config.json`) |
| `CLAUDE_PATH` | *(unset)* | Override the path to the Claude Code binary if auto-detection fails |
| `INSPECTOR_BRIDGE_URL` | `http://127.0.0.1:3131` | Bridge URL used by `mcp-server.js` |

## Sessions

Session ids are persisted per `projectPath::mode` in `.sessions.json` (gitignored), so switching projects never resumes a conversation with the wrong context. Warm processes are disposed after 15 minutes idle; a stale resume id is cleared automatically and retried once. `explain` mode runs with read-only tools (`Read`, `Glob`, `Grep`).

## Auth files

- `.inspector_token` — shared secret, generated on first start (mode 600, gitignored). Delete it to rotate the token.

## Development

```bash
npm test        # node:test — auth, sessions, git tools, prompt builder
npm run lint    # ESLint over bridge + extension
```
