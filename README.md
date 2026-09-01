# Claude Code Inspector

> Visually pick any DOM element on a webpage, describe what you want changed, and let Claude Code do it.

A Chrome extension paired with a local bridge server that lets you point at any element on any page, write a natural-language prompt, and have [Claude Code](https://docs.claude.com/claude-code) modify your project files in place.

```
┌─────────────────────┐   POST /send + WS   ┌───────────────────┐   Agent SDK    ┌──────────────┐
│  Chrome Extension   │ ──────────────────> │   Bridge Server    │ ─────────────> │  Claude Code │
│ (side panel, picker)│ <────────────────── │ (Node, warm sess.) │ <───────────── │  (Agent SDK) │
└─────────────────────┘  WS: progress,      └───────────────────┘   file edits   └──────────────┘
          │              capture requests             │
          │                                           │  MCP (stdio)
          └── DOM→source, screenshots                 └──────────────> Claude Code in your terminal
```

https://github.com/user-attachments/assets/dd3f5a25-765a-461b-8628-cedccc59ed74

## Features

- **Visual DOM picker** — hover and click any element, like Chrome DevTools' inspector. Multi-select supported (pick several elements, finish with Enter).
- **DOM → source** — on React/Vue dev builds the inspector reads the fiber/component debug info and sends Claude the **source file and line** that rendered the element, so it doesn't have to search for the file.
- **Element screenshots** — a cropped screenshot of each selected element is attached to the prompt.
- **Side panel UI** — stays open while you interact with the page: streaming activity log, prompt history, diff preview, undo.
- **Edit & Explain modes** — Edit gives Claude write access; Explain is read-only (`Read`/`Glob`/`Grep` only).
- **Closed verification loop** — optionally, after the edit the bridge reloads the tab, re-captures the element (screenshot included) and asks Claude to self-check and fix its own change.
- **Warm sessions, queued per project** — one persistent Agent SDK process per project (streaming input): no cold spawn per task, context preserved, concurrent prompts queued.
- **Diff preview & undo** — see the git diff of the files a task touched, and undo it with one click (`git stash`, recoverable).
- **Ship it** — checks, commit and push the files a task changed, without leaving the panel. The task line says where the change is (`3 file · solo in locale`) and the panel warns you when the tab you are inspecting is **not** localhost: the bridge edits files, and a published site only shows what has been committed and deployed.
- **The page names its own project** — a `<meta name="claude-inspector-project" content="my-app">` in the page tells the panel which repo to edit, so switching project is switching tab. It is a *name*, not a path: the bridge resolves it under roots you declare locally, and refuses anything outside them.
- **MCP tools** — `get_selected_element` lets Claude Code in your terminal read what you selected in the browser; `list_my_browsers` / `find_browser` / `focus_browser` (Chrome Companion) tell your Chrome profiles apart and bring the right one to the foreground when driving Claude in Chrome.
- **Token-authenticated** — the bridge only accepts requests carrying the secret it prints at startup; web pages are blocked by Origin checks.

## Publishing what the inspector changed

A task ends with edited files on your disk. If you are looking at the deployed
site, nothing changes there — and that gap is where people lose an afternoon.
The panel closes it in two ways: the last-task line says `3 file · solo in
locale`, and **Ship it** publishes.

Ship runs, in order: the project's **checks**, `git add` of **only the files
that task touched** (never `git add -A`: other work in progress is not yours to
publish), `git commit`, `git push`, and — if declared — a deploy command. Every
step is streamed to the activity log, and a failure names the step that broke.

How a project is published is **declared, not detected**, in a
`.claude-inspector.json` committed to the repo:

```json
{
  "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
  "ship":   { "push": true, "branch": "main" },
  "deploy": { "run": "./deploy/deploy.sh", "status": "npx vercel ls --prod" }
}
```

- `checks` — commands that must pass before anything is committed.
- `ship.push` — set `false` to commit only. `ship.branch` refuses to push from
  any other branch, which is almost always a misconfiguration.
- `deploy.run` — a command, if your deploy is something you run (a VPS script,
  a CLI). Where the deploy starts from the push, leave it out: the panel says so
  instead of pretending to know.
- `deploy.status` — a command that prints how it is going, shown in the panel.
  With `waitSeconds` and `readyWhen` it is asked repeatedly until the text
  appears.

The bridge knows nothing about Vercel, Netlify or any host: these are just
commands your project provides. The first time you press Ship on a project
without the file, the panel looks at the repo (`.vercel/project.json`, a
`deploy` script or a `deploy.sh`, a workflow), shows you **what it saw**, and
offers to write the file — a guessed pipeline that runs by itself is the kind of
automation nobody ends up trusting. The package manager comes from the lockfile
only if that command is actually on your `PATH`: a `bun.lockb` left behind by a
scaffold should not make the first Ship die on `command not found`.

Read the proposal before accepting it: detection cannot know that a `lint`
script fails on errors that were already there, and a check like that would
block every publish for reasons that have nothing to do with your change.

⚠️ Those commands run on your machine with your permissions. They come only
from that file inside the project directory, never from the extension or an
HTTP request — the same trust boundary npm scripts already have.

## Quick start

### 1. Install Claude Code

This project assumes [Claude Code](https://docs.claude.com/claude-code) is already installed and authenticated on your machine.

### 2. Run the bridge server

```bash
git clone https://github.com/nemone81/claude-code-inspector.git
cd claude-code-inspector/bridge
npm install
node server.js          # or: npx claude-code-inspector (once published)
```

The bridge listens on `http://localhost:3131` and prints an **auth token** at startup — you'll paste it into the extension.

### 3. Load the Chrome extension

1. Open `chrome://extensions` in Chrome (116+).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. Pin the extension for quick access.

### 4. Use it

1. Click the extension icon — the **side panel** opens.
2. Open settings (⚙), set the **project path** (the repo Claude should edit) and paste the **bridge token**.
3. Click **Select element** (or **Multi-select**) and click element(s) on the page.
4. Pick a mode (**Edit** or **Explain**), optionally enable **Verify after edit**.
5. Type a prompt (e.g. *"increase font-size to 18px and add a hover animation"*) and hit **Send**.

The bridge runs Claude against your project, streams progress into the side panel, and shows an in-page banner on the tab the prompt came from when the task completes. Then you can **View diff** or **Undo task**.

### 5. (Optional) MCP tool for the terminal

```bash
claude mcp add inspector -- node /path/to/claude-code-inspector/bridge/mcp-server.js
```

Then, in a terminal Claude Code session: *"look at the element I selected in the browser"* → Claude calls `get_selected_element` and gets tag, selector, styles, HTML and source file.

## Repository layout

```
claude-code-inspector/
├── extension/        Chrome extension (manifest v3, side panel)
├── bridge/           Node.js bridge server (Agent SDK, WS, MCP) + tests
├── docs/             Architecture, installation, screenshots
├── .github/          CI (lint + tests)
├── LICENSE           Apache 2.0
├── NOTICE
├── CONTRIBUTING.md
└── CHANGELOG.md
```

See [docs/architecture.md](docs/architecture.md) for the full data flow and [docs/installation.md](docs/installation.md) for a deeper setup guide.

## Which project the inspector edits

By default, the repo whose absolute path you typed in the panel's ⚙ settings. Retyping it every time you switch project is friction you pay ten times a day, so a page can name its own project instead:

```html
<meta name="claude-inspector-project" content="my-app">
```

(or `<html data-claude-inspector-project="my-app">` when the `<head>` is out of reach). The panel reads it from the active tab, shows which project is in use and where it came from, and that name wins over the ⚙ field while you are on that page.

**It is a name, not a path — deliberately.** Whoever serves the page writes that tag, production included, so the bridge never takes it for a directory: it resolves the name under the roots you declared **locally**, and refuses anything outside them (no `..` escape, no symlink out of a root, and not a root itself — pointing the agent's cwd at `~/Projects` would hand one meta tag write access to every repo under it). Declare your roots once:

```json
// ~/.claude-inspector/config.json
{ "roots": ["~/Projects"] }
```

or `INSPECTOR_PROJECT_ROOTS=/Users/you/Projects` (`:`-separated). The file is reread on every request — no restart. **With no roots declared, pages cannot choose the project at all**, which is the default. An absolute path in the meta is accepted too, as long as it falls under a root, but publishing one in production HTML hands your username and repo names to anyone who opens the source: prefer the name.

**On a site other than `localhost`, grant access first.** Only `localhost` is in the manifest, so anywhere else the extension cannot inject — and therefore cannot even tell whether the page names a project. The panel says so rather than quietly falling back to the ⚙ path (a plausible, wrong project, on exactly the pages where it matters): the project row shows the hostname and *consenti per leggerlo →*, and clicking it asks Chrome for that host. The first **Select element** on the domain asks for the same permission.

## Requirements

- macOS, Linux, or Windows (tested primarily on macOS).
- **Node.js ≥ 18** for the bridge server.
- **Chrome ≥ 116** (side panel + WebSocket service-worker keepalive).
- Claude Code installed and authenticated.

## Security model

- Every HTTP endpoint and the WebSocket require the shared token generated on first start (`bridge/.inspector_token`, mode 600, gitignored).
- Requests with an `http(s)` `Origin` are rejected outright: a web page open in your browser cannot reach the bridge even if it guesses the port.
- CORS is only ever granted to `chrome-extension://` origins.
- The bridge binds to `127.0.0.1` only.

- A project **declared by a page** is never used as-is: it is a name resolved under the roots you declared locally (`~/.claude-inspector/config.json`), with `..`, symlinks out of a root and the root itself refused. No roots declared, no page-chosen projects. The path typed in ⚙ settings is not filtered — it is your own explicit choice.

Note that Claude runs with `acceptEdits` and skips permission prompts inside the project you configure — point it only at projects you trust it to edit (Explain mode is read-only).

## Configuration

Configurable via environment (see `bridge/.env.example`) or CLI flags (`--port`, `--project`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3131` | Port the bridge listens on |
| `PROJECT_PATH` | `cwd` | Default project the bridge edits when the request omits one |
| `CLAUDE_PATH` | *(unset)* | Override the path to the Claude Code binary if auto-detection fails |
| `INSPECTOR_BRIDGE_URL` | `http://127.0.0.1:3131` | Bridge URL used by the MCP server |
| `INSPECTOR_PROJECT_ROOTS` | *(unset)* | `:`-separated roots under which a page may name its project; overrides `~/.claude-inspector/config.json` |

The extension stores project path, bridge URL and token in `chrome.storage.local` per-browser.

## Development

```bash
cd bridge
npm install
npm test          # node:test suites (auth, sessions, git tools, prompt builder)
npm run lint      # ESLint over bridge + extension
```

CI runs the same on every push/PR.

## Tech stack

- **Extension**: Vanilla JS, Manifest V3 side panel, system fonts, no build step.
- **Bridge**: Node.js, `http` + [`ws`](https://www.npmjs.com/package/ws), warm [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) sessions (streaming input), hand-rolled MCP stdio server.

## Contributing

Contributions are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Acknowledgements

Built on top of [Claude Code](https://docs.claude.com/claude-code) and the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic. The DOM→source idea is inspired by [LocatorJS](https://www.locatorjs.com/).
