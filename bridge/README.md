# Bridge

Local Node.js server that bridges the Chrome extension to the Claude Agent SDK.

## Run

```bash
npm install
node server.js
```

Listens on `http://localhost:3131` by default.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/events`  | SSE stream of task lifecycle events (`task_start`, `task_progress`, `task_done`, `session_reset`) |
| `POST` | `/send`    | Submit a prompt: `{ "prompt": "…", "projectPath": "/abs/path" }` |
| `POST` | `/reset`   | Clear the persisted session id and start fresh on the next prompt |
| `GET`  | `/session` | Inspect the current session id |
| `GET`  | `/health`  | Liveness check + status |

## Configuration

Copy `.env.example` to `.env` (or just set the env vars when launching):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3131` | Port to listen on |
| `PROJECT_PATH` | `cwd` | Default project path used when a request omits one |
| `CLAUDE_PATH` | *(unset)* | Override the path to the Claude Code binary if auto-detection fails |

## Sessions

The bridge persists Claude Agent SDK session ids in `.session_id` (gitignored), so subsequent prompts continue the same conversation. `POST /reset` deletes this file.

If the SDK reports an invalid/expired session, the bridge automatically retries once without `resume`.

## Path normalization

Some clients (notably the Chrome extension on macOS) may send shell-escaped paths such as `/Users/me/my\ project`. The bridge strips the backslashes before passing the path to the SDK so that `cwd` resolves correctly.

## Clipboard fallback

If the SDK call fails entirely, the original prompt is copied to your system clipboard via `pbcopy` so you can paste it into an interactive `claude` terminal session.
