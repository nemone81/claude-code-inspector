# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
