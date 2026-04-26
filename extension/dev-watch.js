#!/usr/bin/env node
// Dev hot-reload server for Claude Code Inspector
// Run with: node dev-watch.js
// The extension auto-reloads on every file change.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = 3132;
const WATCH_DIR = __dirname;
const WATCH_EXT = new Set(['.js', '.html', '.css', '.json']);
const IGNORE    = new Set(['dev-watch.js']);

let clients = [];

// ─── SSE server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/dev-events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive'
    });
    res.write(': connected\n\n'); // SSE comment, not an event
    clients.push(res);
    console.log(`[dev-watch] client connected (total: ${clients.length})`);

    req.on('close', () => {
      clients = clients.filter(c => c !== res);
      console.log(`[dev-watch] client disconnected (total: ${clients.length})`);
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.length }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-watch] Listening on http://localhost:${PORT}/dev-events`);
  console.log(`[dev-watch] Watching: ${WATCH_DIR}`);
  console.log('[dev-watch] Any change to .js/.html/.css/.json files reloads the extension.\n');
});

// ─── File watcher ─────────────────────────────────────────────────────────────
let debounceTimer = null;

fs.watch(WATCH_DIR, { recursive: false }, (eventType, filename) => {
  if (!filename) return;
  if (IGNORE.has(filename)) return;
  if (!WATCH_EXT.has(path.extname(filename))) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[dev-watch] Changed: ${filename} → reloading extension (${clients.length} clients)`);
    const payload = JSON.stringify({ file: filename, ts: Date.now() });
    clients.forEach(c => c.write(`event: reload\ndata: ${payload}\n\n`));
  }, 250);
});
