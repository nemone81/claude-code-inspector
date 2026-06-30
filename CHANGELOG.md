# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2026-06-30

### Added
- **Chrome Companion**: MCP server (stdio) with 3 tools for identifying connected Chrome browser profiles:
  - `list_my_browsers` — lists connected profiles with email, alias, tab counts, and sample tabs.
  - `find_browser` — finds profiles with tabs matching a URL/title substring.
  - `focus_browser` — brings a specific profile's window to the foreground.
- HTTP polling-based snapshot system: the extension sends profile data (email, windows, tabs) to the bridge every 30 seconds and on tab/window changes.
- Stable per-profile UUID (`profileId`) persisted in `chrome.storage.local`, surviving browser restarts.
- Profile email collection via `chrome.identity.getProfileUserInfo()`.
- Alias support: map profileIds to friendly names via `~/.chrome-companion/aliases.json` (auto-reloaded on change).
- Companion bar in the extension popup showing profile email, profileId (click to copy), and bridge connection status.
- HTTP debug endpoints: `GET /browsers`, `GET /browsers/find?q=`, `POST /browsers/:id/focus`.

### Changed
- Bridge server upgraded to v4.0: now acts as both HTTP+SSE bridge AND MCP stdio server in a single process.
- All logging moved to stderr to avoid interfering with MCP stdio protocol on stdout.
- New extension permissions: `identity`, `identity.email`, `tabs`, `windows`.
- Bridge dependency: added `@modelcontextprotocol/sdk`.

## [Unreleased]

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
