#!/usr/bin/env node
// Claude Code Inspector - Bridge Server
// Agent SDK + persistent sessions + SSE notifications

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3131;
const PROJECT_PATH = process.env.PROJECT_PATH || process.cwd();
const SESSION_FILE = path.join(__dirname, '.session_id');
// Optional: override the path to the Claude Code binary.
// When unset, the Agent SDK looks up its bundled binary inside node_modules.
const CLAUDE_PATH = process.env.CLAUDE_PATH || null;

// ─── Verify Agent SDK ─────────────────────────────────────────────────────────
let sdk;
try {
  sdk = require('@anthropic-ai/claude-agent-sdk');
} catch (e) {
  console.error('\n✗ Claude Agent SDK not found. Run: npm install\n');
  process.exit(1);
}
const { query } = sdk;

// ─── SSE client registry ──────────────────────────────────────────────────────
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
  console.log(`[SSE] Client connected (total: ${sseClients.size})`);
  res.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected (total: ${sseClients.size})`);
  });
}

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// Heartbeat every 25s to keep connections alive
setInterval(() => {
  for (const client of sseClients) {
    try { client.write(':ping\n\n'); } catch { sseClients.delete(client); }
  }
}, 25000);

// ─── Persistent session ID ────────────────────────────────────────────────────
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
if (currentSessionId) console.log(`[→] Session resumed: ${currentSessionId.slice(0, 8)}…`);

// ─── CORS / helpers ───────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, data) {
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

// ─── Run via the Agent SDK ────────────────────────────────────────────────────
async function runWithAgentSDK(prompt, projectPath, taskId, isRetry = false) {
  // The Chrome extension may pass shell-escaped paths (e.g. "my\ project").
  // Strip backslash-escaped spaces back to literal spaces.
  const rawDir = projectPath || PROJECT_PATH;
  const dir = rawDir.replace(/\\ /g, ' ');

  if (!fs.existsSync(dir)) {
    const err = new Error(`Project directory not found: ${dir}`);
    console.error(`[✗] ${err.message}`);
    broadcast('task_done', { taskId, success: false, error: err.message });
    throw err;
  }

  console.log(`\n[→] Task ${taskId} · Project: ${dir}`);
  console.log(`[→] Session: ${currentSessionId ? currentSessionId.slice(0, 8) + '…' : 'new'}`);
  console.log(`[→] Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);

  // Notify the extension that the task has started
  broadcast('task_start', { taskId, prompt: prompt.slice(0, 100) });

  const options = {
    cwd: dir,
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
  };
  if (CLAUDE_PATH) options.pathToClaudeCodeExecutable = CLAUDE_PATH;
  if (currentSessionId) options.resume = currentSessionId;

  let newSessionId = null;
  let resultText = '';
  let toolsUsed = [];

  try {
    const q = query({ prompt, options });

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id;
        console.log(`[✓] Session active: ${newSessionId.slice(0, 8)}…`);
      }

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const input = block.input || {};
            const detail = input.file_path || input.command?.slice(0, 50) || '';
            const toolInfo = `${block.name}${detail ? ': ' + detail : ''}`;
            console.log(`   ↳ ${toolInfo}`);
            toolsUsed.push(block.name);
            // Real-time progress notification
            broadcast('task_progress', { taskId, tool: block.name, detail });
          }
        }
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          resultText = msg.result || '';
          const durationSec = (msg.duration_ms / 1000).toFixed(1);
          console.log(`[✓] Completed in ${durationSec}s · ${msg.num_turns} turns · $${msg.total_cost_usd?.toFixed(4) || '?'}`);

          if (newSessionId) {
            currentSessionId = newSessionId;
            saveSessionId(newSessionId);
          }

          // Success notification → the extension will display a Chrome notification
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
    // Session expired → retry without resume
    if (!isRetry && (err.message?.includes('session') || err.message?.includes('resume'))) {
      console.warn('[!] Invalid session, restarting…');
      clearSessionId();
      currentSessionId = null;
      return runWithAgentSDK(prompt, projectPath, taskId, true);
    }

    console.error(`[✗] Task ${taskId} error:`, err.message);
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

// ─── HTTP server ──────────────────────────────────────────────────────────────
let taskCounter = 0;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res); res.writeHead(204); res.end(); return;
  }

  const url = req.url;

  // GET /events — SSE stream for the extension
  if (req.method === 'GET' && url === '/events') {
    addSseClient(res);
    return; // keep the connection open
  }

  // GET /health
  if (req.method === 'GET' && url === '/health') {
    json(res, 200, {
      status: 'ok',
      mode: 'agent-sdk-sessions-sse',
      projectPath: PROJECT_PATH,
      sessionId: currentSessionId ? currentSessionId.slice(0, 8) + '…' : null,
      sseClients: sseClients.size,
      version: '3.0.0'
    });
    return;
  }

  // POST /send
  if (req.method === 'POST' && url === '/send') {
    try {
      const body = await readBody(req);
      const { prompt, projectPath } = body;
      if (!prompt) { json(res, 400, { error: 'missing prompt' }); return; }

      const taskId = `task_${++taskCounter}_${Date.now()}`;
      json(res, 200, { message: 'Started', taskId, sessionId: currentSessionId?.slice(0, 8) || null });

      runWithAgentSDK(prompt, projectPath, taskId).catch(err => {
        console.error('[✗] Clipboard fallback:', err.message);
        copyToClipboard(prompt);
      });

    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // POST /reset
  if (req.method === 'POST' && url === '/reset') {
    clearSessionId(); currentSessionId = null;
    console.log('[→] Session cleared');
    broadcast('session_reset', {});
    json(res, 200, { message: 'Session cleared' });
    return;
  }

  // GET /session
  if (req.method === 'GET' && url === '/session') {
    json(res, 200, { sessionId: currentSessionId || null, projectPath: PROJECT_PATH });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Claude Inspector Bridge              ║');
  console.log('║  Agent SDK · Sessions · SSE           ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`\n✓ Bridge listening on http://localhost:${PORT}`);
  console.log(`✓ Project: ${PROJECT_PATH}`);
  console.log(`✓ Session: ${currentSessionId ? currentSessionId.slice(0, 8) + '… (resumed)' : 'fresh on first prompt'}`);
  if (CLAUDE_PATH) console.log(`✓ Claude binary: ${CLAUDE_PATH}`);
  console.log('\nEndpoints:');
  console.log('  GET  /events  → SSE notification stream');
  console.log('  POST /send    → submit a prompt');
  console.log('  POST /reset   → clear the session');
  console.log('  GET  /health  → status\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`\n✗ Port ${PORT} in use. Try: PORT=3132 node server.js`);
  else console.error('Error:', err);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\nBridge stopped.'); process.exit(0); });
