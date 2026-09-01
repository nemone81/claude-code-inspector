# Architecture

```
   ┌────────────────────────┐
   │   Webpage (any URL)    │
   │  ┌──────────────────┐  │  Inspector overlay, single/multi picker,
   │  │  content.js      │  │  DOM→source detection (React/Vue),
   │  │  content.css     │  │  result banner, element re-capture
   │  └────────┬─────────┘  │
   └───────────┼────────────┘
               │ chrome.runtime messages (injected on demand)
               ▼
   ┌────────────────────────┐        POST /send (token)   ┌────────────────────┐
   │   Side panel           │ ──────────────────────────> │   Bridge server    │
   │   (sidepanel.html/.js) │                             │   (Node.js)        │
   │   - element cards +    │                             │   server.js        │
   │     screenshots        │                             │   lib/sessions.js  │
   │   - edit/explain mode  │                             │   lib/auth.js      │
   │   - activity log,      │                             │   lib/git-tools.js │
   │     history, diff/undo │                             └───┬────────────┬───┘
   └────────────┬───────────┘                                 │            │
                │                                             │ Agent SDK  │ stdio
                ▼                                             ▼            ▼
   ┌────────────────────────┐    WS /ws?token=…     ┌────────────────┐  ┌─────────────────┐
   │   background.js        │ <───────────────────> │  Claude Code   │  │  mcp-server.js  │
   │   - WebSocket client   │  events: task_*,      │  (warm session │  │  get_selected_  │
   │     (keeps SW alive)   │  verify_*, capture_*  │  per project)  │  │  element → your │
   │   - screenshot crop    │                       └────────┬───────┘  │  terminal       │
   │   - notifications      │                                │ writes   └─────────────────┘
   └────────────────────────┘                                ▼
                                                    ┌────────────────────┐
                                                    │  Your project files│
                                                    └────────────────────┘
```

## Components

### Chrome extension

- **`content.js`** is injected **on demand only** (a window guard makes re-injection a no-op, so listeners are never duplicated). It provides the hover overlay, single and multi-select picking, and serializes element info: tag, classes, CSS selector, XPath, computed styles, viewport rect, outer HTML, page URL, and — on React/Vue dev builds — the **source file/line** of the component that rendered the element (`_debugSource` fiber walk, `__vueParentComponent.type.__file`, Vue 2 `$options.__file`). It also re-captures an element by selector for the verification loop and renders the persistent task banner.
- **`sidepanel.html` / `sidepanel.js`** replace the old popup. The panel stays open while you interact with the page and hosts: config (project path, bridge URL, auth token), element cards with cropped screenshots and source chips, Edit/Explain mode toggle, verify checkbox, quick prompts + DevTools-style color picker, a streaming activity log, prompt history with re-send, diff preview and undo.
- **`extension/lib/prompt-builder.js`** builds the message sent to Claude (UMD-style so the bridge test suite can `require` it).
- **`background.js`** is the service worker. It keeps a **WebSocket** open to the bridge — on Chrome 116+ an active WS keeps the MV3 worker alive, so no `chrome.alarms` hack is needed. It routes bridge events to the side panel, shows notifications, sends the completion banner to **the tab the prompt came from** (tracked per task), crops element screenshots (`captureVisibleTab` + `OffscreenCanvas`), and services the bridge's `capture_request` during verification (reload tab → wait → re-inject → re-capture → reply over WS).

### Bridge server (`bridge/`)

Runtime deps: `@anthropic-ai/claude-agent-sdk` (pinned) and `ws`.

- **`lib/auth.js`** — a shared secret is generated on first start (`.inspector_token`, mode 600) and printed at startup. Every endpoint and the WS handshake require it. Requests carrying an `http(s)` `Origin` are rejected regardless of token, so web pages can never reach the bridge; CORS is only reflected for `chrome-extension://` origins. The server binds to `127.0.0.1`.
- **`lib/sessions.js`** — the core. One **warm Agent SDK process per (project, mode)** using streaming input: prompts are pushed into a long-lived `query()`, eliminating the cold spawn per task and preserving conversation context. Tasks on the same project are **queued** (promise chain), never run concurrently on one session. Session ids are persisted in `.sessions.json` keyed by `projectPath::mode`, so a bridge restart resumes the right session for the right project. Idle processes are disposed after 15 min. `explain` mode restricts tools to `Read`/`Glob`/`Grep`.
- **`lib/git-tools.js`** — diff and undo via `execFile` (no shell interpolation). Undo uses `git stash push --include-untracked -- <files>`: recoverable, and it also removes files the task created.
- **`server.js`** — HTTP endpoints (`/send`, `/diff`, `/undo`, `/reset`, `/session`, `/selected`, `/health`) + the `/ws` WebSocket. Tracks the files each task modified (from `tool_use` blocks) for diff/undo, forwards the originating `tabId` with every event, and orchestrates the **verification loop**: on `task_done` with `verify: true` it asks the extension to reload + re-capture the element (screenshot included) and pushes a self-check turn into the same warm session; if Claude finds the change wrong, it fixes it (`verify_done` reports whether a fix was applied). One round, no recursion.
- **`lib/companion.js`** — the Chrome Companion store: each extension instance announces its profile (id, email, windows, tabs) over the WS; the store tracks connected profiles, prunes stale ones (~2 min), resolves aliases from `~/.chrome-companion/aliases.json` (hot-reloaded), and manages focus round-trips. Snapshots arrive only on change (the extension sends a light ping otherwise) and URLs of sensitive domains are redacted client-side. Exposed via `GET /browsers`, `GET /browsers/find?q=`, `POST /browsers/:id/focus`.
- **`mcp-server.js`** — dependency-free MCP stdio server exposing `get_selected_element` plus the companion tools `list_my_browsers`, `find_browser`, `focus_browser`; it reads the token file and calls the bridge over HTTP. Being a separate process from the bridge, one bridge can serve many concurrent MCP client sessions. Register with `claude mcp add inspector -- node …/bridge/mcp-server.js`.
- **`cli.js`** — `npx claude-code-inspector [--port N] [--project DIR] [--mcp]`.

### Claude Code

The bridge invokes Claude Code via the Agent SDK with `permissionMode: 'acceptEdits'` and `allowDangerouslySkipPermissions: true` in Edit mode (`allowedTools: Read/Write/Edit/Bash/Glob/Grep`), read-only tools in Explain mode. Combined with token + Origin auth and the localhost-only bind, this is scoped to a local developer setup.

## Data flow for one prompt

1. User clicks **Select element** in the side panel → background injects `content.js` into the active tab → user picks element(s).
2. Content script sends `elementsSelected` → background stores the selection (with the tab id), pushes it to the bridge over WS (for the MCP tool), captures cropped screenshots, and notifies the panel.
3. User types a prompt and hits Send → panel builds the message (prompt + element blocks + source info) and POSTs `/send` with `{ prompt, projectPath | project, mode, tabId, verify, elements, images }` and the auth token. `project` is what the *page* declared in its `<meta>`; the bridge resolves it under the locally declared roots (`lib/projects.js`), while `projectPath` is what the user typed in settings and is used as-is.
4. Bridge answers immediately with a `taskId` and queues the task on the project's warm session; `task_start` / `task_progress` / `task_done` stream over WS as Claude works.
5. Background shows notifications and forwards events to the panel's activity log; on `task_done` the banner goes to the originating tab.
6. If verify was enabled and files changed: bridge sends `capture_request` → background reloads the tab, re-captures element + screenshot → bridge pushes a verification turn into the same session → `verify_done` (with `fixed: true` if Claude corrected itself).
7. From the panel the user can **View diff** (`GET /diff?taskId=`) or **Undo task** (`POST /undo`, git stash).

## Security notes

- The bridge listens **only on `127.0.0.1`** — never on `0.0.0.0`.
- All endpoints and the WS require the startup token; `http(s)` origins are rejected outright (a malicious page cannot `fetch('http://localhost:3131/send')` anymore).
- The extension's default `host_permissions` cover localhost only; `<all_urls>` is an *optional* permission the user can grant for non-localhost verification flows.
- No remote network calls from extension or bridge except those originating from Claude Code itself when it calls the Anthropic API.
