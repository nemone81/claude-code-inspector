#!/usr/bin/env node
// npx entry point: `npx claude-code-inspector [--port N] [--project DIR] [--mcp]`

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-code-inspector — local bridge between the Chrome extension and the Claude Agent SDK

Usage:
  claude-code-inspector [options]     start the bridge server
  claude-code-inspector --mcp         start the MCP stdio server (for: claude mcp add)

Options:
  --port N        port to listen on (default 3131, or $PORT)
  --project DIR   default project directory (default: cwd, or $PROJECT_PATH)
  -h, --help      this help
`);
  process.exit(0);
}

if (args.includes('--mcp')) {
  require('./mcp-server.js');
} else {
  const port = argValue('--port');
  const project = argValue('--project');
  if (port) process.env.PORT = port;
  if (project) process.env.PROJECT_PATH = project;
  require('./server.js');
}
