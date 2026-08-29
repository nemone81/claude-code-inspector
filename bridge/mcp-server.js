#!/usr/bin/env node
// Claude Code Inspector — MCP server (stdio)
//
// Exposes the element(s) currently selected in the Chrome extension to any
// MCP client, so from Claude Code in the terminal you can say
// "look at what I selected" without going through the side panel.
//
// Register it with:
//   claude mcp add inspector -- node /path/to/bridge/mcp-server.js
//
// It talks to the local bridge over HTTP using the shared token file.

const http = require('http');
const readline = require('readline');
const { readToken } = require('./lib/auth');

const BRIDGE_URL = process.env.INSPECTOR_BRIDGE_URL || 'http://127.0.0.1:3131';
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'get_selected_element',
    description:
      'Returns the DOM element(s) currently selected in the Claude Code Inspector Chrome extension: ' +
      'tag, CSS selector, classes, computed styles, HTML snippet, page URL and (when available in a ' +
      'React/Vue dev build) the source file and line of the component that rendered it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_my_browsers',
    description:
      'List all connected Chrome browser profiles with email, alias, tab counts, and sample tabs. ' +
      'Use this to identify which browser to target with Claude in Chrome.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_browser',
    description:
      'Find which connected Chrome browser has a tab matching a URL or title substring (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match against tab URLs and titles' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_browser',
    description:
      'Bring a connected Chrome browser profile to the foreground. Sends a focus command to the extension in that profile.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The profileId of the browser to focus (from list_my_browsers)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function bridgeRequest(method, pathname, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const token = readToken();
    if (!token) { reject(new Error('Bridge token not found — start the bridge once first.')); return; }
    const req = http.request(`${BRIDGE_URL}${pathname}`, {
      method,
      headers: { 'X-Inspector-Token': token },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`Bridge answered ${res.statusCode}: ${body.slice(0, 200)}`));
        else resolve(body);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('bridge timeout')); });
    req.on('error', (e) => reject(new Error(`Bridge unreachable at ${BRIDGE_URL} (${e.message}). Is it running?`)));
    req.end();
  });
}

// tool name → request against the bridge; the JSON body is returned as-is.
async function callTool(name, args) {
  switch (name) {
    case 'get_selected_element': {
      const data = JSON.parse(await bridgeRequest('GET', '/selected'));
      if (!data.elements || !data.elements.length) {
        return 'No element is currently selected in the Chrome extension.';
      }
      return JSON.stringify(data, null, 2);
    }
    case 'list_my_browsers':
      return JSON.stringify(JSON.parse(await bridgeRequest('GET', '/browsers')), null, 2);
    case 'find_browser': {
      if (!args?.query) throw new Error('missing required argument: query');
      const q = encodeURIComponent(args.query);
      return JSON.stringify(JSON.parse(await bridgeRequest('GET', `/browsers/find?q=${q}`)), null, 2);
    }
    case 'focus_browser': {
      if (!args?.id) throw new Error('missing required argument: id');
      const id = encodeURIComponent(args.id);
      return await bridgeRequest('POST', `/browsers/${id}/focus`, { timeout: 50000 });
    }
    default:
      return null; // unknown tool
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-code-inspector', version: '4.0.0' },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications need no response

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      try {
        const text = await callTool(params?.name, params?.arguments);
        if (text === null) {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        reply(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
      return;
    }

    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  pending++;
  handle(msg)
    .catch((err) => {
      if (msg.id !== undefined) replyError(msg.id, -32603, err.message);
    })
    .finally(() => { pending--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
