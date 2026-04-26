# Architecture

```
   ┌────────────────────────┐
   │   Webpage (any URL)    │
   │  ┌──────────────────┐  │
   │  │  content.js      │  │  Inspector overlay, picker,
   │  │  content.css     │  │  result banner, EyeDropper
   │  └────────┬─────────┘  │
   └───────────┼────────────┘
               │ chrome.runtime messages
               ▼
   ┌────────────────────────┐         POST /send       ┌────────────────────┐
   │   Extension popup      │ ───────────────────────> │   Bridge server    │
   │   (popup.html / .js)   │                          │   (Node.js, SSE)   │
   │   - DevTools color     │ <─────────────────────── │                    │
   │     picker             │       SSE: progress      │   server.js        │
   │   - prompt + element   │                          └─────────┬──────────┘
   │     context            │                                    │
   └────────────┬───────────┘                                    │ Agent SDK
                │                                                ▼
                │                                       ┌────────────────────┐
                ▼                                       │   Claude Code      │
   ┌────────────────────────┐                           │   (CLI / SDK)      │
   │   background.js        │                           │   - Read / Write   │
   │   - SSE client         │ <───── SSE stream ──────  │   - Edit / Bash    │
   │   - notifications      │                           └─────────┬──────────┘
   │   - dev-watch reload   │                                     │
   └────────────────────────┘                                     │ writes
                                                                  ▼
                                                         ┌────────────────────┐
                                                         │   Your project     │
                                                         │   files            │
                                                         └────────────────────┘
```

## Components

### Chrome extension

- **`content.js`** is injected into every page (`<all_urls>`). When activated, it adds a hover overlay, captures a click, and serializes element info (tag, classes, computed styles, dimensions, outer HTML, page URL) into a structured payload that is sent to the popup via `chrome.runtime.sendMessage`. It also listens for `taskResult` messages from the background and shows a persistent in-page banner with a cache-bypassing reload button.
- **`popup.html` / `popup.js`** present the picked element, a prompt textarea, and a DevTools-style color picker (saturation/value square, hue + alpha sliders, hex input, palette, EyeDropper). Hitting *Send* either POSTs to the bridge or copies the message to the clipboard.
- **`background.js`** is the long-lived service worker. It maintains an SSE connection to `http://localhost:3131/events`, surfaces task lifecycle events as Chrome notifications, and forwards `task_done` events to the active tab so the in-page banner can render. A `chrome.alarms` keepalive prevents the worker from going idle. It also connects to the optional dev-watch SSE feed to reload the extension on file changes.

### Bridge server (`bridge/server.js`)

- Pure Node.js (no Express, no other deps) — the only runtime dependency is `@anthropic-ai/claude-agent-sdk`.
- Exposes:
  - `POST /send` — accepts `{ prompt, projectPath }`, returns immediately with a `taskId`, then runs `query()` from the Agent SDK and broadcasts SSE events as messages stream in.
  - `GET /events` — SSE stream of `task_start`, `task_progress`, `task_done`, `session_reset` events.
  - `POST /reset` — clears the persisted session id.
  - `GET /session`, `GET /health` — introspection.
- **Sessions**: the SDK returns a `session_id` on the first turn. The bridge writes it to `.session_id` and passes it as `resume` on subsequent prompts, so Claude keeps context across requests. If the SDK reports an invalid session, the bridge retries once without `resume`.
- **Path normalization**: the extension occasionally sends shell-escaped paths like `/Users/me/my\ project`. The bridge converts the `\ ` sequences to literal spaces before passing the path to the SDK as `cwd`.

### Claude Code

The bridge invokes Claude Code via the Agent SDK with `permissionMode: 'acceptEdits'`, `allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']`, and `allowDangerouslySkipPermissions: true`. Because the bridge only listens on `127.0.0.1`, this is safe for a local developer setup.

## Data flow for one prompt

1. User selects an element with the inspector → content script sends `elementSelected` to the popup.
2. User types a prompt and hits Send → popup constructs the full prompt (prompt text + selected element block) and POSTs it to `/send`.
3. Bridge receives the request, returns `{ taskId, sessionId }` immediately, broadcasts `task_start` over SSE.
4. Bridge runs `query()`. As Claude calls tools (Read, Write, Edit, Bash…), the bridge broadcasts `task_progress` for each `tool_use` block.
5. When the SDK emits a `result` message, the bridge broadcasts `task_done` with `success`, `durationSec`, `turns`, and a count of files modified.
6. The background service worker forwards `task_done` to the active tab, which renders a persistent banner with the result and a *Reload without cache* button.
7. If the user clicks reload → content script sends `reloadTabNoCache` to the background, which calls `chrome.tabs.reload(tabId, { bypassCache: true })`.

## Security notes

- The bridge listens **only on `127.0.0.1`** — never on `0.0.0.0`. It is a developer-only tool.
- The extension's `host_permissions` allow it to talk to localhost only.
- There is no remote network call from the extension or the bridge except those originating from Claude Code itself when it calls the Anthropic API.
