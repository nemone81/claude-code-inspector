# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Inspecting a page outside `localhost` failed with *“Extension manifest must request permission to access this host”*: the side panel now asks for the page's host permission (from the optional `<all_urls>` grant) when **Inspect** is clicked, instead of letting `scripting.executeScript` fail.

### Added
- **The page can name its own project**: a `<meta name="claude-inspector-project" content="my-app">` (or `<html data-claude-inspector-project>`) in the inspected page picks the repo, so switching project is switching tab instead of retyping a path in settings. The panel shows which project is active and where it came from.
- Roots allowlist for page-declared projects (`~/.claude-inspector/config.json`, `INSPECTOR_PROJECT_ROOTS`) and the `GET /project/resolve` endpoint the panel uses to show the resolved directory — or the reason it was refused — before the prompt is sent.
- **Ship it**: the panel can now run the project's checks, commit the files a task changed and push them, with every step streamed to the activity log. How a project is published is declared in a `.claude-inspector.json` in the repo (`checks`, `ship`, `deploy`); the bridge runs those commands and knows nothing about any hosting provider. Missing the file, the first Ship shows what it found in the repo and offers to write it.
- The last-task line says **where the change is** (`3 file · solo in locale` → `pubblicato · a1b2c3d`), and the panel warns when the inspected tab is not localhost: the bridge edits files on disk, and a deployed site only shows what has been committed and deployed. Without this, "done" reads as "it is online".
- In-extension setup guide (`extension/help.html`): opens automatically on first install and via the **?** button in the side panel — bridge startup + token, panel configuration, usage, MCP registration, troubleshooting.

### Security
- A project named by a page is treated as a request, not a path: whoever serves the page writes that tag, production included, so the bridge resolves it only under locally declared roots and refuses `..` escapes, symlinks leaving a root, and the root itself. With no roots declared, pages cannot choose the project at all.

## [4.0.0] - 2026-08-29

### Security
- The bridge now requires a shared **auth token** on every endpoint and on the WebSocket. The token is generated on first start (`bridge/.inspector_token`, mode 600) and printed at startup.
- Requests with an `http(s)` `Origin` are rejected: web pages can no longer reach the bridge (previously CORS was `*` with no auth, so any open page could execute commands in the project).
- Removed the server-side `execSync` clipboard fallback (shell-injection risk, macOS-only); the extension already handles the clipboard fallback client-side.

### Added
- **Side panel UI** replacing the popup: stays open while inspecting, streaming activity log, prompt history with re-send, config with token field.
- **Multi-select**: pick several elements in one round (Enter/Esc to finish).
- **Explain mode**: read-only sessions (`Read`/`Glob`/`Grep` only) alongside Edit mode.
- **DOM → source**: on React/Vue dev builds the element's source file and line (`_debugSource`, `__vueParentComponent`, Vue 2 `$options.__file`) are detected and sent with the prompt.
- **Element screenshots**: cropped `captureVisibleTab` shots of each selected element, attached to the prompt as images.
- **Closed verification loop** (opt-in): after an edit the bridge reloads the tab, re-captures the element and asks Claude to self-check and fix its own change.
- **Diff preview & undo**: `GET /diff` shows the git diff of the files a task touched; `POST /undo` stashes them (recoverable with `git stash pop`).
- **MCP server** (`bridge/mcp-server.js`, dependency-free stdio): exposes `get_selected_element` so Claude Code in the terminal can read the browser selection. Register with `claude mcp add inspector -- node …/bridge/mcp-server.js`.
- **Chrome Companion integrated** (merged from the previously separate Dropbox fork, now retired): each Chrome profile with the extension announces itself to the bridge over the WS (profile id, email, windows, tabs) so Claude can tell browsers apart. Endpoints `GET /browsers`, `GET /browsers/find?q=`, `POST /browsers/:id/focus` and MCP tools `list_my_browsers`, `find_browser`, `focus_browser`. Improvements over the fork: snapshots are sent **only on change** (light keepalive ping otherwise, vs. a full snapshot every 30 s), URLs of sensitive domains (password managers, payment providers, Google accounts — configurable via `sensitiveDomains` in storage) are **redacted**, everything rides the authenticated WS instead of unauthenticated HTTP polling, and the MCP server is a separate process from the bridge (the fork bundled them, so per-session MCP spawns died on `EADDRINUSE`). Aliases still live in `~/.chrome-companion/aliases.json`.
- **`npx claude-code-inspector`** entry point (`cli.js` with `--port`, `--project`, `--mcp`).
- Test suite (`node --test`): auth, session pool, git tools, prompt builder. ESLint flat config over bridge + extension. GitHub Actions CI.

### Changed
- **Sessions are now per project** (and per mode), keyed by `projectPath` and persisted in `bridge/.sessions.json` — switching projects no longer resumes a session with the wrong context.
- **Warm SDK processes**: one persistent Agent SDK query per (project, mode) using streaming input — no cold spawn per task; idle processes are disposed after 15 minutes.
- **Task queue**: concurrent `/send` requests on the same project run sequentially instead of in parallel on the same session.
- **SSE → WebSocket**: the bridge pushes events over `ws://…/ws`; on Chrome 116+ the active WebSocket keeps the MV3 service worker alive, replacing the `chrome.alarms` keepalive (which Chrome rounded up to 30 s anyway).
- The completion banner is delivered to the **tab the prompt came from** (tab id tracked per task), not whatever tab is active when the task finishes.
- Content script is now injected **on demand only** (guarded against double injection); the `<all_urls>` content-script declaration was removed. `<all_urls>` remains available as an *optional* host permission.
- Popup fonts: Google Fonts import replaced with system font stacks (no network fetch on open).
- Prompt building unified in English and moved to `extension/lib/prompt-builder.js` (shared with the test suite).
- Versions aligned: extension manifest, bridge package and `/health` all report **4.0.0**. Bridge package renamed to `claude-code-inspector`; Agent SDK dependency pinned (no more `latest`).

### Removed
- `extension/popup.html` / `popup.js` (superseded by the side panel).
- `chrome.alarms` keepalive and the `alarms` permission.

## [3.1.0] - 2026-08 (initial public release)

### Added
- DevTools-style color picker in the popup: saturation/value square, hue and alpha sliders, hex input, 40-color palette, EyeDropper picker for grabbing colors from the page.
- Persistent in-page banner shown when a task completes, with a *Reload without cache* button.
- Path normalization in the bridge: shell-escaped paths (e.g. `my\ project`) are converted to literal spaces before being passed to the SDK.
- Optional `CLAUDE_PATH` env variable to override the path to the Claude Code binary if the bundled one cannot be detected.
- Apache 2.0 license, NOTICE file, contributor guide, project README and per-component READMEs.

### Changed
- Extension and bridge fully translated to English.
- Bridge package renamed to `claude-code-inspector-bridge` and bumped to `1.0.0`.
- Chrome notifications on task completion now use `requireInteraction: true` so they don't auto-dismiss.

### Fixed
- Spawn errors with `ENOENT` caused by shell-escaped project paths.
- Manifest icon paths for the new `icons/` subfolder.
