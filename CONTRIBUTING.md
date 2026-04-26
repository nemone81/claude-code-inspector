# Contributing

Thanks for your interest in improving Claude Code Inspector! Issues and pull requests are very welcome.

## Development setup

```bash
git clone https://github.com/nemone81/claude-code-inspector.git
cd claude-code-inspector

# Bridge
cd bridge
npm install
node server.js
```

In a second terminal, optionally run the hot-reload server for the extension:

```bash
cd extension
node dev-watch.js
```

Then load `extension/` as an unpacked extension at `chrome://extensions`.

## Project structure

- `extension/` — Chrome MV3 extension (vanilla JS, no build step)
- `bridge/` — Node.js HTTP/SSE bridge using `@anthropic-ai/claude-agent-sdk`
- `docs/` — architecture notes, installation guide, screenshots

## Code style

- **No build pipeline.** Vanilla JS, kept readable.
- **Tabs vs spaces:** match the surrounding file (project default: 2 spaces).
- **No frameworks** in the extension — keep it lightweight.
- **English** for all UI strings, comments, console output, and identifiers.

## Pull requests

1. Fork the repo and create a feature branch off `main`.
2. Keep PRs focused — one logical change per PR is easier to review.
3. Test your change manually (load unpacked in Chrome, run the bridge).
4. Update the relevant README / `CHANGELOG.md` if user-facing behaviour changes.
5. Open a PR with a clear description of *why* the change matters.

## Reporting bugs

Please include:

- Chrome version
- Node.js version (`node -v`)
- Output of `node server.js` (the bridge logs)
- Steps to reproduce
- What you expected vs. what happened

## Security

If you discover a security issue, please open a private security advisory on GitHub rather than a public issue.
