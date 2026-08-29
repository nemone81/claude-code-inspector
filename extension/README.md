# Extension

Chrome extension (Manifest V3, Chrome ≥ 116) that lets you pick DOM elements on any page and dispatch prompts to the local bridge from a **side panel**.

## Files

- `manifest.json` — extension manifest
- `background.js` — service worker; WebSocket client to the bridge (keeps the worker alive), notifications, banner routing to the originating tab, screenshot capture/cropping, verification captures, dev hot-reload client
- `content.js` — visual DOM picker (single + multi-select), DOM→source detection for React/Vue dev builds, element re-capture, task-result banner. Injected **on demand only**, guarded against double injection
- `content.css` — picker overlay/tooltip styles
- `sidepanel.html` / `sidepanel.js` — side panel UI: config (project, bridge URL, token), element cards with screenshots and source chips, edit/explain modes, verify toggle, color picker, activity log, prompt history, diff preview, undo
- `lib/prompt-builder.js` — builds the message sent to Claude (shared with the bridge test suite)
- `dev-watch.js` — local SSE server that triggers `chrome.runtime.reload()` on file changes
- `icons/` — toolbar / store icons

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the toolbar icon to open the side panel, then set the bridge **token** in ⚙ settings (the bridge prints it at startup).

## Hot-reload during development

```bash
node dev-watch.js
```

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Inject the picker into the current tab |
| `scripting` | On-demand content-script injection |
| `storage` | Persist config, mode, prompt history |
| `clipboardWrite` | Clipboard fallback when the bridge is offline |
| `notifications` | Task progress / completion toasts |
| `sidePanel` | The main UI |
| `tabs` | Companion: window/tab snapshots so the bridge can tell browser profiles apart |
| `identity`, `identity.email` | Companion: profile email shown in `list_my_browsers` |

The companion snapshot is sent only to the local bridge over the authenticated WebSocket, only when tabs actually change; URLs of sensitive domains (password managers, payment providers, Google accounts) are redacted — the list is configurable via the `sensitiveDomains` key in `chrome.storage.local`.

## Host permissions

Default: `localhost` / `127.0.0.1` only. `<all_urls>` is declared as an **optional** host permission — grant it from `chrome://extensions` if you need screenshots/verification on non-localhost pages. The extension never sends anything to a remote host.
