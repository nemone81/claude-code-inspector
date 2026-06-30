#!/usr/bin/env node
// Claude Code Inspector + Chrome Companion - Bridge Server v4
// Agent SDK + sessioni persistenti + SSE + HTTP companion polling + MCP

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3131;
const PROJECT_PATH = process.env.PROJECT_PATH || process.cwd();
const SESSION_FILE = path.join(__dirname, '.session_id');
const ALIAS_DIR = path.join(os.homedir(), '.chrome-companion');
const ALIAS_FILE = path.join(ALIAS_DIR, 'aliases.json');
const STALE_TIMEOUT_MS = 90_000;

// ─── Verifica Agent SDK ───────────────────────────────────────────────────────
let sdk;
try {
  sdk = require('@anthropic-ai/claude-agent-sdk');
} catch (e) {
  logStderr('\n✗ Claude Agent SDK non trovato. Esegui: npm install\n');
  process.exit(1);
}
const { query } = sdk;

// ─── Verifica MCP SDK ─────────────────────────────────────────────────────────
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// ─── SSE Client Registry ──────────────────────────────────────────────────────
const sseClients = new Set();

function addSseClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  logStderr(`[SSE] Client connesso (totale: ${sseClients.size})`);
  res.on('close', () => {
    sseClients.delete(res);
    logStderr(`[SSE] Client disconnesso (totale: ${sseClients.size})`);
  });
}

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

setInterval(() => {
  for (const client of sseClients) {
    try { client.write(':ping\n\n'); } catch { sseClients.delete(client); }
  }
}, 25000);

// ─── Logging: stderr per non interferire con MCP stdio ────────────────────────
function logStderr(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

// ─── Session ID persistente ───────────────────────────────────────────────────
function loadSessionId() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const id = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      if (id) return id;
    }
  } catch {}
  return null;
}
function saveSessionId(id) {
  try { fs.writeFileSync(SESSION_FILE, id, 'utf8'); } catch {}
}
function clearSessionId() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
}

let currentSessionId = loadSessionId();
if (currentSessionId) logStderr(`[→] Sessione ripresa: ${currentSessionId.slice(0, 8)}…`);

// ─── CORS / helpers ───────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function jsonResponse(res, code, data) {
  setCors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME COMPANION — Browser Store
// ═══════════════════════════════════════════════════════════════════════════════

const browserStore = new Map();
const pendingCommands = new Map();

function storeUpsert(profileId, snapshot) {
  browserStore.set(profileId, {
    snapshot,
    lastSeen: new Date(),
  });
}

function storeGetAll() {
  pruneStale();
  return [...browserStore.entries()].map(([id, entry]) => ({
    id,
    alias: getAlias(id),
    email: entry.snapshot.email || '',
    windowCount: entry.snapshot.windows?.length || 0,
    tabCount: entry.snapshot.tabs?.length || 0,
    sampleTabs: pickSampleTabs(entry.snapshot.tabs, 5),
    lastSeen: entry.lastSeen.toISOString(),
  }));
}

function storeFindByQuery(q) {
  pruneStale();
  const ql = q.toLowerCase();
  const matches = [];
  for (const [id, entry] of browserStore) {
    const matched = (entry.snapshot.tabs || []).filter(t =>
      (t.url && t.url.toLowerCase().includes(ql)) ||
      (t.title && t.title.toLowerCase().includes(ql))
    );
    if (matched.length > 0) {
      matches.push({
        id,
        alias: getAlias(id),
        email: entry.snapshot.email || '',
        matchedTabs: matched.map(t => ({ title: t.title, url: t.url, windowId: t.windowId })),
      });
    }
  }
  return matches;
}

function pruneStale() {
  const now = Date.now();
  for (const [id, entry] of browserStore) {
    if (now - entry.lastSeen.getTime() > STALE_TIMEOUT_MS) {
      browserStore.delete(id);
    }
  }
}

function pickSampleTabs(tabs, max) {
  if (!tabs || tabs.length === 0) return [];
  const active = tabs.filter(t => t.active);
  const rest = tabs.filter(t => !t.active);
  return [...active, ...rest].slice(0, max).map(t => ({ title: t.title, url: t.url }));
}

// ─── Focus via polling ────────────────────────────────────────────────────────

function queueFocusCommand(profileId) {
  return new Promise((resolve) => {
    pendingCommands.set(profileId, {
      command: { type: 'focus' },
      resolve,
      timer: setTimeout(() => {
        if (pendingCommands.has(profileId)) {
          pendingCommands.delete(profileId);
          resolve({ success: false, error: 'Timeout: estensione non ha risposto entro 45s' });
        }
      }, 45000),
    });
  });
}

function getPendingCommand(profileId) {
  const entry = pendingCommands.get(profileId);
  if (entry) return entry.command;
  return null;
}

function resolveFocusCommand(profileId, result) {
  const entry = pendingCommands.get(profileId);
  if (entry) {
    clearTimeout(entry.timer);
    entry.resolve(result);
    pendingCommands.delete(profileId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME COMPANION — Alias Manager
// ═══════════════════════════════════════════════════════════════════════════════

let aliases = {};

function loadAliases() {
  try {
    if (fs.existsSync(ALIAS_FILE)) {
      aliases = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'));
    }
  } catch {
    aliases = {};
  }
}

function getAlias(profileId) {
  return aliases[profileId] || null;
}

function initAliases() {
  try {
    if (!fs.existsSync(ALIAS_DIR)) fs.mkdirSync(ALIAS_DIR, { recursive: true });
    if (!fs.existsSync(ALIAS_FILE)) fs.writeFileSync(ALIAS_FILE, '{}', 'utf8');
  } catch {}
  loadAliases();
  try {
    fs.watch(ALIAS_FILE, { persistent: false }, () => loadAliases());
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME COMPANION — MCP Server (stdio)
// ═══════════════════════════════════════════════════════════════════════════════

async function initMcp() {
  const mcpServer = new McpServer({
    name: 'chrome-companion',
    version: '1.0.0',
  });

  mcpServer.tool(
    'list_my_browsers',
    'List all connected Chrome browser profiles with email, alias, tab counts, and sample tabs. Use this to identify which browser to target with Claude in Chrome.',
    {},
    async () => {
      const browsers = storeGetAll();
      return {
        content: [{ type: 'text', text: JSON.stringify({ browsers }, null, 2) }],
      };
    }
  );

  mcpServer.tool(
    'find_browser',
    'Find which connected Chrome browser has a tab matching a URL or title substring (case-insensitive).',
    { query: z.string().describe('Substring to match against tab URLs and titles') },
    async ({ query: q }) => {
      const matches = storeFindByQuery(q);
      return {
        content: [{ type: 'text', text: JSON.stringify({ matches }, null, 2) }],
      };
    }
  );

  mcpServer.tool(
    'focus_browser',
    'Bring a connected Chrome browser profile to the foreground. Sends a focus command to the extension in that profile.',
    { id: z.string().describe('The profileId of the browser to focus (from list_my_browsers)') },
    async ({ id }) => {
      if (!browserStore.has(id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Profilo non trovato' }) }] };
      }
      const result = await queueFocusCommand(id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logStderr('[MCP] Server stdio avviato');
}

// ─── Run con Agent SDK ────────────────────────────────────────────────────────
async function runWithAgentSDK(prompt, projectPath, taskId, isRetry = false) {
  const rawDir = projectPath || PROJECT_PATH;
  const dir = rawDir
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\ /g, ' ')
    .trim();

  if (!fs.existsSync(dir)) {
    const err = new Error(`Directory progetto non trovata: ${dir}`);
    logStderr(`[✗] ${err.message}`);
    broadcast('task_done', { taskId, success: false, error: err.message });
    throw err;
  }

  logStderr(`\n[→] Task ${taskId} · Progetto: ${dir}`);
  logStderr(`[→] Sessione: ${currentSessionId ? currentSessionId.slice(0, 8) + '…' : 'nuova'}`);
  logStderr(`[→] Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);

  broadcast('task_start', { taskId, prompt: prompt.slice(0, 100) });

  const options = {
    cwd: dir,
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
  };
  if (currentSessionId) options.resume = currentSessionId;

  let newSessionId = null;
  let resultText = '';
  let toolsUsed = [];

  try {
    const q = query({ prompt, options });

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id;
        logStderr(`[✓] Sessione attiva: ${newSessionId.slice(0, 8)}…`);
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const input = block.input || {};
            const detail = input.file_path || input.command?.slice(0, 50) || '';
            const toolInfo = `${block.name}${detail ? ': ' + detail : ''}`;
            logStderr(`   ↳ ${toolInfo}`);
            toolsUsed.push(block.name);
            broadcast('task_progress', { taskId, tool: block.name, detail });
          }
        }
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          resultText = msg.result || '';
          const durationSec = (msg.duration_ms / 1000).toFixed(1);
          logStderr(`[✓] Completato in ${durationSec}s · ${msg.num_turns} turns · $${msg.total_cost_usd?.toFixed(4) || '?'}`);

          if (newSessionId) {
            currentSessionId = newSessionId;
            saveSessionId(newSessionId);
          }

          broadcast('task_done', {
            taskId,
            success: true,
            result: resultText.slice(0, 300),
            durationSec,
            turns: msg.num_turns,
            filesModified: [...new Set(toolsUsed.filter(t => ['Write', 'Edit'].includes(t)))].length,
          });

          return { success: true, output: resultText };

        } else {
          const errors = msg.errors?.join(', ') || msg.subtype;
          throw new Error(errors);
        }
      }
    }

  } catch (err) {
    if (!isRetry && (err.message?.includes('session') || err.message?.includes('resume'))) {
      logStderr('[!] Sessione non valida, riavvio...');
      clearSessionId();
      currentSessionId = null;
      return runWithAgentSDK(prompt, projectPath, taskId, true);
    }

    logStderr(`[✗] Errore task ${taskId}:`, err.message);
    broadcast('task_done', {
      taskId,
      success: false,
      error: err.message.slice(0, 200),
    });
    throw err;
  }
}

function copyToClipboard(text) {
  try {
    execSync(`echo '${text.replace(/'/g, "'\\''")}' | pbcopy`);
    return true;
  } catch { return false; }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
let taskCounter = 0;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res); res.writeHead(204); res.end(); return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // GET /events — SSE stream per l'estensione
  if (req.method === 'GET' && pathname === '/events') {
    addSseClient(res);
    return;
  }

  // GET /health
  if (req.method === 'GET' && pathname === '/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      mode: 'agent-sdk-sessions-sse-mcp',
      projectPath: PROJECT_PATH,
      sessionId: currentSessionId ? currentSessionId.slice(0, 8) + '…' : null,
      sseClients: sseClients.size,
      browsers: browserStore.size,
      version: '4.0.0'
    });
    return;
  }

  // POST /send
  if (req.method === 'POST' && pathname === '/send') {
    try {
      const body = await readBody(req);
      const { prompt, projectPath } = body;
      if (!prompt) { jsonResponse(res, 400, { error: 'prompt mancante' }); return; }

      const taskId = `task_${++taskCounter}_${Date.now()}`;
      jsonResponse(res, 200, { message: 'Avviato', taskId, sessionId: currentSessionId?.slice(0, 8) || null });

      runWithAgentSDK(prompt, projectPath, taskId).catch(err => {
        logStderr('[✗] Fallback clipboard:', err.message);
        copyToClipboard(prompt);
      });

    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // POST /reset
  if (req.method === 'POST' && pathname === '/reset') {
    clearSessionId(); currentSessionId = null;
    logStderr('[→] Sessione azzerata');
    broadcast('session_reset', {});
    jsonResponse(res, 200, { message: 'Sessione azzerata' });
    return;
  }

  // GET /session
  if (req.method === 'GET' && pathname === '/session') {
    jsonResponse(res, 200, { sessionId: currentSessionId || null, projectPath: PROJECT_PATH });
    return;
  }

  // ─── Chrome Companion HTTP endpoints ──────────────────────────────────────

  // POST /companion/snapshot — estensione invia snapshot periodico
  if (req.method === 'POST' && pathname === '/companion/snapshot') {
    try {
      const body = await readBody(req);
      if (!body.profileId) { jsonResponse(res, 400, { error: 'profileId mancante' }); return; }

      storeUpsert(body.profileId, body);
      logStderr(`[Companion] Snapshot da ${body.profileId.slice(0, 8)}… (${body.email || '?'}) — ${body.tabs?.length || 0} tab`);

      const cmd = getPendingCommand(body.profileId);
      jsonResponse(res, 200, { ok: true, command: cmd });
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // POST /companion/focus_ack — estensione conferma focus
  if (req.method === 'POST' && pathname === '/companion/focus_ack') {
    try {
      const body = await readBody(req);
      if (body.profileId) {
        resolveFocusCommand(body.profileId, { success: body.success, windowId: body.windowId });
      }
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // GET /browsers — lista profili connessi
  if (req.method === 'GET' && pathname === '/browsers') {
    jsonResponse(res, 200, { browsers: storeGetAll() });
    return;
  }

  // GET /browsers/find?q=...
  if (req.method === 'GET' && pathname === '/browsers/find') {
    const q = parsedUrl.searchParams.get('q') || '';
    jsonResponse(res, 200, { matches: storeFindByQuery(q) });
    return;
  }

  // POST /browsers/:id/focus
  const focusMatch = pathname.match(/^\/browsers\/([^/]+)\/focus$/);
  if (req.method === 'POST' && focusMatch) {
    const id = decodeURIComponent(focusMatch[1]);
    if (!browserStore.has(id)) {
      jsonResponse(res, 404, { success: false, error: 'Profilo non trovato' });
      return;
    }
    const result = await queueFocusCommand(id);
    jsonResponse(res, 200, result);
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
});

// ─── Avvio ────────────────────────────────────────────────────────────────────
initAliases();

server.listen(PORT, '127.0.0.1', () => {
  logStderr('\n╔═══════════════════════════════════════════╗');
  logStderr('║  Claude Inspector + Companion  v4.0      ║');
  logStderr('║  Agent SDK · SSE · HTTP Polling · MCP    ║');
  logStderr('╚═══════════════════════════════════════════╝');
  logStderr(`\n✓ Bridge su http://localhost:${PORT}`);
  logStderr(`✓ MCP su stdio`);
  logStderr(`✓ Progetto: ${PROJECT_PATH}`);
  logStderr(`✓ Sessione: ${currentSessionId ? currentSessionId.slice(0, 8) + '… (ripresa)' : 'nuova al primo prompt'}`);
  logStderr(`✓ Alias: ${ALIAS_FILE}`);
  logStderr('\nEndpoint:');
  logStderr('  GET  /events              → SSE stream notifiche');
  logStderr('  POST /send                → invia prompt');
  logStderr('  POST /reset               → azzera sessione');
  logStderr('  GET  /health              → status');
  logStderr('  POST /companion/snapshot  → ricevi snapshot da estensione');
  logStderr('  POST /companion/focus_ack → ack focus da estensione');
  logStderr('  GET  /browsers            → lista profili connessi');
  logStderr('  GET  /browsers/find?q=    → cerca per url/title');
  logStderr('  POST /browsers/:id/focus  → focus su profilo\n');
});

initMcp().catch(err => {
  logStderr(`[MCP] Errore avvio: ${err.message}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') logStderr(`\n✗ Porta ${PORT} in uso. Usa: PORT=3132 node server.js`);
  else logStderr('Errore:', err);
  process.exit(1);
});

process.on('SIGINT', () => { logStderr('\nBridge fermato.'); process.exit(0); });
