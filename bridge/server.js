#!/usr/bin/env node
// Claude Code Inspector — Bridge Server v4
// Agent SDK warm sessions · per-project queues · WebSocket · token auth

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const { loadOrCreateToken, authorize, isOriginAllowed, tokenFromRequest, timingSafeEqual } = require('./lib/auth');
const { SessionPool, MODES } = require('./lib/sessions');
const { diffFiles, undoFiles } = require('./lib/git-tools');
const { detectProject, readShipConfig, writeShipConfig, ship, watchDeploy, CONFIG_FILE } = require('./lib/ship');
const { CompanionStore, ALIAS_FILE } = require('./lib/companion');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3131;
const PROJECT_PATH = process.env.PROJECT_PATH || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || null;
const VERSION = '4.0.0';

// ─── Agent SDK ────────────────────────────────────────────────────────────────
let sdk;
try {
  sdk = require('@anthropic-ai/claude-agent-sdk');
} catch {
  console.error('\n✗ Claude Agent SDK not found. Run: npm install\n');
  process.exit(1);
}

const TOKEN = loadOrCreateToken();
const pool = new SessionPool({ query: sdk.query, claudePath: CLAUDE_PATH });

// ─── WebSocket clients ────────────────────────────────────────────────────────
let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('\n✗ "ws" package not found. Run: npm install\n');
  process.exit(1);
}

const wsClients = new Set();
const pendingCaptures = new Map(); // requestId → { resolve, timer }

function broadcast(type, data) {
  const payload = JSON.stringify({ type, ...data });
  for (const client of wsClients) {
    try { client.send(payload); } catch { wsClients.delete(client); }
  }
}

// Ask the extension to reload a tab and re-capture an element. Resolves with
// { element, screenshot } or rejects on timeout / capture error.
function requestCapture({ tabId, selector }) {
  if (!wsClients.size) return Promise.reject(new Error('extension not connected'));
  const requestId = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCaptures.delete(requestId);
      reject(new Error('capture timed out'));
    }, 45000);
    pendingCaptures.set(requestId, { resolve, reject, timer });
    broadcast('capture_request', { requestId, tabId, selector, screenshot: true });
  });
}

function handleWsMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case 'selection':
      lastSelection = { elements: msg.elements || [], pageUrl: msg.pageUrl || null, at: new Date().toISOString() };
      break;

    case 'capture_response': {
      const pending = pendingCaptures.get(msg.requestId);
      if (!pending) return;
      pendingCaptures.delete(msg.requestId);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve({ element: msg.element || null, screenshot: msg.screenshot || null });
      break;
    }

    // ── Companion: browser profile snapshots + focus acks ──
    case 'companion_snapshot':
      if (!msg.profileId) return;
      ws.profileId = msg.profileId;
      companion.upsert(msg.profileId, {
        email: msg.email || '',
        windows: msg.windows || [],
        tabs: msg.tabs || [],
        timestamp: msg.timestamp || Date.now(),
      });
      break;

    case 'companion_ping':
      if (!msg.profileId) return;
      ws.profileId = msg.profileId;
      companion.touch(msg.profileId);
      break;

    case 'focus_ack':
      if (!msg.profileId) return;
      companion.resolveFocus(msg.profileId, {
        success: !!msg.success,
        windowId: msg.windowId || null,
        error: msg.error || undefined,
      });
      break;
  }
}

// Send a focus command to the extension instance for one profile and await its ack.
function requestFocus(profileId) {
  const client = [...wsClients].find((c) => c.profileId === profileId);
  if (!client) return Promise.resolve({ success: false, error: 'Profile not connected over WebSocket' });
  const result = companion.awaitFocus(profileId);
  try { client.send(JSON.stringify({ type: 'focus_request', profileId })); } catch { /* timeout will fire */ }
  return result;
}

// ─── State ────────────────────────────────────────────────────────────────────
let lastSelection = null;      // { elements, pageUrl, at } — served to the MCP tool
const tasks = new Map();       // taskId → task record (for diff / undo)
let taskCounter = 0;
const companion = new CompanionStore();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setCors(res, req) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Inspector-Token');
  }
}

function json(res, req, code, data) {
  setCors(res, req);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); return; }
      body += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function resolveProjectDir(projectPath) {
  // The extension may pass shell-escaped paths ("my\ project").
  const dir = (projectPath || PROJECT_PATH).replace(/\\ /g, ' ');
  if (!fs.existsSync(dir)) throw new Error(`Project directory not found: ${dir}`);
  return dir;
}

function imageBlocks(images) {
  return (images || [])
    .filter((img) => img && img.data && /^image\/(png|jpeg|webp|gif)$/.test(img.media_type || ''))
    .slice(0, 4)
    .map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    }));
}

function truncate(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── Task execution ───────────────────────────────────────────────────────────
async function runTask(task) {
  const { taskId, dir, mode } = task;
  console.log(`\n[→] Task ${taskId} · ${mode} · ${dir}`);
  console.log(`[→] Prompt: ${truncate(task.prompt, 120)}`);

  broadcast('task_start', { taskId, tabId: task.tabId, prompt: truncate(task.prompt, 100) });

  const contentBlocks = [{ type: 'text', text: task.prompt }, ...imageBlocks(task.images)];

  try {
    const result = await pool.run({
      dir,
      mode,
      taskId,
      contentBlocks,
      onProgress: ({ tool, detail }) => {
        console.log(`   ↳ ${tool}${detail ? ': ' + detail : ''}`);
        broadcast('task_progress', { taskId, tabId: task.tabId, tool, detail });
      },
    });

    task.files = result.files;
    task.status = 'done';
    console.log(`[✓] Completed in ${result.durationSec}s · ${result.turns} turns · $${result.costUsd?.toFixed(4) || '?'}`);

    broadcast('task_done', {
      taskId,
      tabId: task.tabId,
      success: true,
      result: truncate(result.output, 300),
      durationSec: result.durationSec,
      turns: result.turns,
      filesModified: result.files.length,
      canUndo: result.files.length > 0,
      // Cosa serve per pubblicarlo, e se il progetto ha detto come farlo. Il
      // pannello deve poter dire "e' solo in locale" senza chiedere altro.
      canShip: result.files.length > 0,
      shipConfigured: !!readShipConfig(dir),
    });

    if (task.verify && task.tabId && task.selector && result.files.length) {
      await runVerification(task, result);
    }
  } catch (err) {
    task.status = 'failed';
    console.error(`[✗] Task ${taskId} error:`, err.message);
    broadcast('task_done', { taskId, tabId: task.tabId, success: false, error: truncate(err.message, 200) });
  }
}

// Closed verification loop: reload the tab, re-capture the element, and let
// Claude self-check (and fix) its own change. Single round, no recursion.
async function runVerification(task, editResult) {
  const { taskId } = task;
  console.log(`[→] Verifying ${taskId}…`);
  broadcast('verify_start', { taskId, tabId: task.tabId });

  try {
    const captured = await requestCapture({ tabId: task.tabId, selector: task.selector });

    let text = 'VERIFICATION STEP — the page was reloaded after your changes.\n';
    text += `Original request: ${truncate(task.prompt, 1500)}\n\n`;
    if (captured.element) {
      text += 'The selected element, re-captured after reload:\n';
      text += JSON.stringify(captured.element, null, 2).slice(0, 3000);
    } else {
      text += 'The originally selected element could NOT be found after reload (its selector no longer matches).';
    }
    if (captured.screenshot) text += '\n\nA fresh screenshot of the element is attached.';
    text += '\n\nCheck whether the original request is now correctly implemented. ';
    text += 'If it is, reply with a one-line confirmation. If not, fix the code accordingly.';

    const blocks = [{ type: 'text', text }, ...imageBlocks(captured.screenshot ? [captured.screenshot] : [])];

    const result = await pool.run({
      dir: task.dir,
      mode: task.mode,
      taskId: `${taskId}_verify`,
      contentBlocks: blocks,
      onProgress: ({ tool, detail }) => broadcast('task_progress', { taskId, tabId: task.tabId, tool, detail, phase: 'verify' }),
    });

    // Any extra file the fix touched should stay undoable too.
    task.files = [...new Set([...(task.files || []), ...result.files])];
    console.log(`[✓] Verification done: ${truncate(result.output, 100)}`);
    broadcast('verify_done', {
      taskId,
      tabId: task.tabId,
      success: true,
      fixed: result.files.length > 0,
      result: truncate(result.output, 300),
    });
  } catch (err) {
    console.error(`[✗] Verification ${taskId} error:`, err.message);
    broadcast('verify_done', { taskId, tabId: task.tabId, success: false, error: truncate(err.message, 200) });
  }
  void editResult;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res, req);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  // Unauthenticated ping: enough to show "bridge up", nothing more.
  if (route === 'GET /health' && !tokenFromRequest(req)) {
    json(res, req, 200, { status: 'ok', version: VERSION, auth: 'token required' });
    return;
  }

  const auth = authorize(req, TOKEN);
  if (!auth.ok) {
    json(res, req, auth.code, { error: auth.error });
    return;
  }

  try {
    switch (route) {
      case 'GET /health': {
        json(res, req, 200, {
          status: 'ok',
          version: VERSION,
          mode: 'agent-sdk-warm-sessions-ws-companion',
          defaultProject: PROJECT_PATH,
          sessions: pool.status(),
          wsClients: wsClients.size,
          browsers: companion.list().length,
        });
        return;
      }

      case 'POST /send': {
        const body = await readBody(req);
        const { prompt, projectPath, tabId, verify, elements, images } = body;
        const mode = MODES[body.mode] ? body.mode : 'edit';
        if (!prompt) { json(res, req, 400, { error: 'missing prompt' }); return; }

        let dir;
        try { dir = resolveProjectDir(projectPath); } catch (e) {
          json(res, req, 400, { error: e.message });
          return;
        }

        const taskId = `task_${++taskCounter}_${Date.now()}`;
        const task = {
          taskId,
          dir,
          mode,
          prompt,
          images,
          tabId: tabId || null,
          verify: !!verify && mode === 'edit',
          selector: elements?.[0]?.selector || null,
          files: [],
          status: 'queued',
          createdAt: new Date().toISOString(),
        };
        tasks.set(taskId, task);
        if (tasks.size > 50) tasks.delete(tasks.keys().next().value);

        json(res, req, 200, { message: 'queued', taskId, mode });
        runTask(task); // runs in background; queued per project inside the pool
        return;
      }

      case 'GET /diff': {
        const task = tasks.get(url.searchParams.get('taskId'));
        if (!task) { json(res, req, 404, { error: 'unknown task' }); return; }
        const result = await diffFiles(task.dir, task.files);
        json(res, req, 200, { taskId: task.taskId, files: task.files, ...result });
        return;
      }

      case 'POST /undo': {
        const body = await readBody(req);
        const task = tasks.get(body.taskId);
        if (!task) { json(res, req, 404, { error: 'unknown task' }); return; }
        if (!task.files.length) { json(res, req, 400, { error: 'task modified no files' }); return; }
        const result = await undoFiles(task.dir, task.files, `claude-inspector undo ${task.taskId}`);
        task.status = 'undone';
        console.log(`[↩] Undid ${task.taskId}: ${result.stashed.join(', ')}`);
        json(res, req, 200, { message: 'Changes stashed (recover with: git stash pop)', ...result });
        return;
      }

      case 'POST /reset': {
        const body = await readBody(req);
        pool.reset(body.projectPath ? resolveProjectDir(body.projectPath) : null);
        console.log('[→] Session(s) cleared');
        broadcast('session_reset', {});
        json(res, req, 200, { message: 'Session cleared' });
        return;
      }

      case 'GET /session': {
        json(res, req, 200, { sessions: pool.status(), defaultProject: PROJECT_PATH });
        return;
      }

      case 'GET /selected': {
        json(res, req, 200, lastSelection || { elements: [], at: null });
        return;
      }

      // ── Ship: checks, commit, push, deploy ──

      /**
       * Come si pubblica questo progetto, e cosa si potrebbe proporre se non
       * lo ha ancora dichiarato.
       *
       * `detected` non fa partire niente: e' la prova che il pannello mostra a
       * chi deve confermare ("qui c'e' un .vercel/project.json"), perche' una
       * configurazione indovinata che esegue comandi da sola e' esattamente
       * l'automatismo che poi non si lascia acceso.
       */
      case 'GET /ship/config': {
        let dir;
        try { dir = resolveProjectDir(url.searchParams.get('projectPath')); } catch (e) {
          json(res, req, 400, { error: e.message });
          return;
        }
        const config = readShipConfig(dir);
        json(res, req, 200, {
          dir,
          file: CONFIG_FILE,
          config,
          detected: config ? null : detectProject(dir),
        });
        return;
      }

      case 'POST /ship/config': {
        const body = await readBody(req);
        let dir;
        try { dir = resolveProjectDir(body.projectPath); } catch (e) {
          json(res, req, 400, { error: e.message });
          return;
        }
        if (!body.config || typeof body.config !== 'object') {
          json(res, req, 400, { error: 'missing config' });
          return;
        }
        const config = writeShipConfig(dir, body.config);
        console.log(`[⚙] ${CONFIG_FILE} scritto in ${dir}`);
        json(res, req, 200, { config, file: CONFIG_FILE });
        return;
      }

      case 'POST /ship': {
        const body = await readBody(req);
        const task = tasks.get(body.taskId);
        if (!task) { json(res, req, 404, { error: 'unknown task' }); return; }
        if (!task.files.length) { json(res, req, 400, { error: 'task modified no files' }); return; }
        if (task.shipping) { json(res, req, 409, { error: 'already shipping' }); return; }

        task.shipping = true;
        json(res, req, 200, { message: 'shipping', taskId: task.taskId });

        // Si risponde subito e si racconta il resto sul WebSocket: i controlli
        // di un progetto vero durano minuti, e una richiesta HTTP tenuta
        // aperta per minuti muore da sola nel modo peggiore, cioe' senza dire
        // a che punto era arrivata.
        (async () => {
          const onEvent = (event) => {
            broadcast('ship_progress', { taskId: task.taskId, tabId: task.tabId, ...event });
            if (event.status === 'running' || event.status === 'failed') {
              console.log(`[⇧] ${event.step} ${event.status}${event.command ? ': ' + event.command : ''}`);
            }
          };

          try {
            const result = await ship({
              dir: task.dir,
              files: task.files,
              message: typeof body.message === 'string' ? body.message : null,
              prompt: task.prompt,
              onEvent,
            });
            task.shipped = result.ok;
            broadcast('ship_done', { taskId: task.taskId, tabId: task.tabId, ...result });

            // Lo stato del deploy si guarda solo se e' andata bene: dopo un
            // fallimento non c'e' niente da aspettare.
            if (result.ok) await watchDeploy({ dir: task.dir, onEvent });
          } catch (err) {
            broadcast('ship_done', {
              taskId: task.taskId,
              tabId: task.tabId,
              ok: false,
              steps: [{ step: 'ship', status: 'failed', error: truncate(err.message, 200) }],
            });
          } finally {
            task.shipping = false;
          }
        })();
        return;
      }

      // ── Companion endpoints ──
      case 'GET /browsers': {
        json(res, req, 200, { browsers: companion.list() });
        return;
      }

      case 'GET /browsers/find': {
        json(res, req, 200, { matches: companion.find(url.searchParams.get('q') || '') });
        return;
      }

      default: {
        const focusMatch = url.pathname.match(/^\/browsers\/([^/]+)\/focus$/);
        if (req.method === 'POST' && focusMatch) {
          const id = decodeURIComponent(focusMatch[1]);
          if (!companion.has(id)) {
            json(res, req, 404, { success: false, error: 'Profile not found' });
            return;
          }
          json(res, req, 200, await requestFocus(id));
          return;
        }
        json(res, req, 404, { error: 'Not found' });
      }
    }
  } catch (err) {
    json(res, req, 500, { error: err.message });
  }
});

// ─── WebSocket endpoint (/ws) ─────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || '';
  if (url.pathname !== '/ws' || !isOriginAllowed(req.headers.origin) || !timingSafeEqual(token, TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsClients.add(ws);
    console.log(`[WS] Client connected (total: ${wsClients.size})`);
    ws.on('message', (raw) => handleWsMessage(ws, raw));
    ws.on('close', () => {
      wsClients.delete(ws);
      if (ws.profileId) companion.remove(ws.profileId);
      console.log(`[WS] Client disconnected (total: ${wsClients.size})`);
    });
    ws.on('error', () => wsClients.delete(ws));
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Claude Inspector Bridge v4           ║');
  console.log('║  Agent SDK · Warm sessions · WS       ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`\n✓ Bridge listening on http://localhost:${PORT}`);
  console.log(`✓ Default project: ${PROJECT_PATH}`);
  if (CLAUDE_PATH) console.log(`✓ Claude binary: ${CLAUDE_PATH}`);
  console.log(`\n🔑 Auth token (paste it in the extension side panel):\n   ${TOKEN}`);
  console.log('\nEndpoints (all require the token):');
  console.log('  WS   /ws        → event stream + element capture channel');
  console.log('  POST /send      → submit a prompt (queued per project)');
  console.log('  GET  /diff      → diff of a task\'s modified files');
  console.log('  POST /undo      → stash a task\'s changes');
  console.log('  POST /reset     → clear session(s)');
  console.log('  GET  /selected  → last selected element(s) (used by MCP)');
  console.log('  GET  /browsers  → connected Chrome profiles (companion)');
  console.log('  GET  /browsers/find?q=      → find browser by tab url/title');
  console.log('  POST /browsers/:id/focus    → bring a browser to the foreground');
  console.log('  GET  /health    → status');
  console.log(`\n✓ Companion aliases: ${ALIAS_FILE}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n✗ Port ${PORT} in use. Try: PORT=3132 node server.js`);
  else console.error('Error:', err);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\nBridge stopped.'); process.exit(0); });

module.exports = { server };
