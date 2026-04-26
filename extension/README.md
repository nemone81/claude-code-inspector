# Extension

Chrome extension (Manifest V3) that lets you pick a DOM element on any page and dispatch a prompt to the local bridge.

## Files

- `manifest.json` — extension manifest
- `background.js` — service worker; SSE client to the bridge, notifications, in-page banner dispatch, dev hot-reload client
- `content.js` — visual DOM picker injected into every page; persistent task-result banner
- `content.css` — picker overlay/tooltip styles
- `popup.html` / `popup.js` — toolbar popup UI: element preview, prompt area, color picker, bridge status, settings
- `dev-watch.js` — local SSE server that triggers `chrome.runtime.reload()` whenever an extension file changes
- `icons/` — toolbar / store icons

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Hot-reload during development

```bash
node dev-watch.js
```

Then any change in this folder reloads the extension automatically.

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Inject the picker into the current tab |
| `scripting` | Programmatic content-script injection (fallback) |
| `storage` | Persist project path, bridge URL, and mode |
| `clipboardWrite` | Clipboard fallback when the bridge is offline |
| `notifications` | Task progress / completion toasts |
| `alarms` | Keep the service worker alive |

## Host permissions

The extension only talks to `localhost` / `127.0.0.1` — it never sends anything to a remote host.
