// Claude Code Inspector — Side Panel
// Stays open while you interact with the page: config, selection,
// streaming activity log, prompt history, diff preview and undo.

/* global PromptBuilder */

let config = { projectPath: '', bridgeUrl: 'http://localhost:3131', token: '' };
let selection = null;          // { elements, screenshots, pageUrl, tabId }
let mode = 'edit';             // 'edit' | 'explain'
let lastTaskId = null;
let history = [];

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadHistory();
  bindEvents();
  initColorPicker();
  refreshSelectionFromBackground();
  checkBridgeStatus();
  setInterval(checkBridgeStatus, 10000);
});

async function loadConfig() {
  const saved = await chrome.storage.local.get(['config', 'mode']);
  if (saved.config) config = { ...config, ...saved.config };
  if (saved.mode === 'explain') mode = 'explain';
  $('projectPath').value = config.projectPath;
  $('bridgeUrl').value = config.bridgeUrl;
  $('tokenInput').value = config.token || '';
  setMode(mode);
}

async function loadHistory() {
  const saved = await chrome.storage.local.get(['history']);
  history = saved.history || [];
  renderHistory();
}

function $(id) { return document.getElementById(id); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-Inspector-Token': config.token || '' };
}

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  $('configToggle').addEventListener('click', () => $('configPanel').classList.toggle('open'));
  $('saveConfig').addEventListener('click', saveConfig);
  $('resetSessionBtn').addEventListener('click', resetSession);

  $('inspectBtn').addEventListener('click', () => startInspector(false));
  $('inspectMultiBtn').addEventListener('click', () => startInspector(true));
  $('clearElements').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearSelection' });
  });

  $('modeEdit').addEventListener('click', () => setMode('edit'));
  $('modeExplain').addEventListener('click', () => setMode('explain'));

  document.querySelectorAll('.quick-btn[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = $('promptInput');
      ta.value = btn.dataset.prompt + ' ';
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      updateSendBtn();
    });
  });

  $('promptInput').addEventListener('input', updateSendBtn);
  $('promptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendToClaude();
  });
  $('sendBtn').addEventListener('click', sendToClaude);
  $('copyBtn').addEventListener('click', copyPrompt);

  $('diffBtn').addEventListener('click', showDiff);
  $('undoBtn').addEventListener('click', undoTask);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'selectionChanged') {
      selection = msg.selection;
      renderSelection();
    }
    if (msg.action === 'bridgeStatus') {
      renderBridgeStatus(msg.connected);
    }
    if (msg.action === 'bridgeEvent') {
      handleBridgeEvent(msg.event);
    }
  });
}

// ─── Inspector ────────────────────────────────────────────────────────────────
function startInspector(multi) {
  chrome.runtime.sendMessage({ action: 'injectInspector', multi }, (res) => {
    if (!res?.ok) {
      showStatus(`Cannot inspect this page: ${res?.error || 'unknown error'}`, 'error');
    } else if (res.active) {
      showStatus(multi
        ? 'Multi-select active — click elements on the page, Enter to finish'
        : 'Inspector active — click an element on the page', 'success');
    }
  });
}

function refreshSelectionFromBackground() {
  chrome.runtime.sendMessage({ action: 'getSelection' }, (res) => {
    selection = res?.selection || null;
    renderSelection();
  });
}

function renderSelection() {
  const panel = $('elementsPanel');
  const list = $('elementsList');
  list.innerHTML = '';

  const els = selection?.elements || [];
  panel.classList.toggle('hidden', !els.length);

  els.forEach((el, i) => {
    const card = document.createElement('div');
    card.className = 'element-card';

    const shot = selection.screenshots?.[i];
    if (shot?.data) {
      const img = document.createElement('img');
      img.src = `data:${shot.media_type};base64,${shot.data}`;
      card.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'info';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = `<${el.tag}>` + (el.id ? ` #${el.id}` : '');
    const sel = document.createElement('div');
    sel.className = 'selector';
    sel.textContent = el.selector;
    sel.title = el.selector;
    info.append(tag, sel);
    if (el.source?.fileName || el.source?.componentName) {
      const src = document.createElement('div');
      src.className = 'source';
      const file = el.source.fileName
        ? el.source.fileName.split('/').slice(-2).join('/') + (el.source.lineNumber ? ':' + el.source.lineNumber : '')
        : '';
      src.textContent = `${el.source.framework} · ${el.source.componentName || ''} ${file}`.trim();
      src.title = el.source.fileName || '';
      info.appendChild(src);
    }
    card.appendChild(info);

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'removeSelectedElement', index: i });
    });
    card.appendChild(rm);

    list.appendChild(card);
  });
}

// ─── Mode ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  chrome.storage.local.set({ mode });
  $('modeEdit').classList.toggle('active', m === 'edit');
  $('modeExplain').classList.toggle('active', m === 'explain');
  $('verifyRow').style.display = m === 'edit' ? 'flex' : 'none';
  $('sendBtnText').textContent = m === 'edit' ? 'SEND TO CLAUDE' : 'ASK CLAUDE (read-only)';
}

// ─── Config ───────────────────────────────────────────────────────────────────
async function saveConfig() {
  config.projectPath = $('projectPath').value.trim();
  config.bridgeUrl = $('bridgeUrl').value.trim() || 'http://localhost:3131';
  config.token = $('tokenInput').value.trim();
  await chrome.storage.local.set({ config });
  chrome.runtime.sendMessage({ action: 'configUpdated' });
  $('configPanel').classList.remove('open');
  showStatus('Configuration saved ✓', 'success');
  checkBridgeStatus();
}

async function resetSession() {
  try {
    const res = await fetch(`${config.bridgeUrl}/reset`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ projectPath: config.projectPath || undefined }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    showStatus('Session reset ✓ — the next request starts fresh', 'success');
    checkBridgeStatus();
  } catch (e) {
    showStatus('Reset failed: ' + e.message, 'error');
  }
}

// ─── Send ─────────────────────────────────────────────────────────────────────
function currentImages() {
  if (!$('screenshotCheck').checked) return [];
  return (selection?.screenshots || []).filter(Boolean).slice(0, 4);
}

function builtMessage() {
  const prompt = $('promptInput').value.trim();
  return PromptBuilder.buildMessage(prompt, selection?.elements || [], {
    mode,
    hasScreenshots: currentImages().length > 0,
  });
}

async function sendToClaude() {
  const prompt = $('promptInput').value.trim();
  if (!prompt) return;

  const btn = $('sendBtn');
  btn.disabled = true;

  try {
    const res = await fetch(`${config.bridgeUrl}/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: builtMessage(),
        projectPath: config.projectPath,
        mode,
        tabId: selection?.tabId || null,
        verify: mode === 'edit' && $('verifyCheck').checked,
        elements: selection?.elements || [],
        images: currentImages(),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Bridge error: ${res.status}`);

    lastTaskId = data.taskId;
    $('taskActions').classList.remove('visible');
    $('diffView').classList.remove('open');
    showStatus('✓ Queued — Claude is on it', 'success');
    pushHistory(prompt);
  } catch (e) {
    btn.disabled = false;
    if (/Failed to fetch|NetworkError/.test(e.message)) {
      showStatus('Bridge unreachable. Start it with:\n  npx claude-code-inspector\nPrompt copied to clipboard as fallback.', 'error');
      await navigator.clipboard.writeText(builtMessage()).catch(() => {});
    } else {
      showStatus('Error: ' + e.message, 'error');
    }
  }
}

async function copyPrompt() {
  const prompt = $('promptInput').value.trim();
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(builtMessage());
    showStatus('✓ Copied — paste it in your terminal', 'success');
    pushHistory(prompt);
  } catch (e) {
    showStatus('Copy failed: ' + e.message, 'error');
  }
}

function updateSendBtn() {
  $('sendBtn').disabled = !$('promptInput').value.trim();
}

// ─── History ──────────────────────────────────────────────────────────────────
function pushHistory(prompt) {
  history = [{ prompt, at: Date.now() }, ...history.filter((h) => h.prompt !== prompt)].slice(0, 15);
  chrome.storage.local.set({ history });
  renderHistory();
}

function renderHistory() {
  const panel = $('historyPanel');
  const list = $('historyList');
  list.innerHTML = '';
  panel.classList.toggle('hidden', !history.length);
  history.forEach((h) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.textContent = h.prompt;
    item.title = 'Click to reuse';
    item.addEventListener('click', () => {
      $('promptInput').value = h.prompt;
      updateSendBtn();
      $('promptInput').focus();
    });
    list.appendChild(item);
  });
}

// ─── Diff / Undo ──────────────────────────────────────────────────────────────
async function showDiff() {
  if (!lastTaskId) return;
  const view = $('diffView');
  if (view.classList.contains('open')) { view.classList.remove('open'); return; }
  try {
    const res = await fetch(`${config.bridgeUrl}/diff?taskId=${encodeURIComponent(lastTaskId)}`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    view.innerHTML = '';
    if (!data.isRepo) view.textContent = 'Not a git repository — no diff available.';
    else if (!data.diff) view.textContent = 'No changes detected.';
    else {
      data.diff.split('\n').forEach((line) => {
        const div = document.createElement('div');
        if (line.startsWith('+') && !line.startsWith('+++')) div.className = 'add';
        if (line.startsWith('-') && !line.startsWith('---')) div.className = 'del';
        div.textContent = line;
        view.appendChild(div);
      });
    }
    view.classList.add('open');
  } catch (e) {
    showStatus('Diff failed: ' + e.message, 'error');
  }
}

let undoArmed = false;
async function undoTask() {
  if (!lastTaskId) return;
  const btn = $('undoBtn');
  if (!undoArmed) {
    undoArmed = true;
    btn.textContent = 'Really undo? (click again)';
    setTimeout(() => { undoArmed = false; btn.textContent = '↩ Undo task'; }, 4000);
    return;
  }
  undoArmed = false;
  btn.textContent = '↩ Undo task';
  try {
    const res = await fetch(`${config.bridgeUrl}/undo`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ taskId: lastTaskId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showStatus(`↩ ${data.message}\n${(data.stashed || []).join('\n')}`, 'success');
    $('taskActions').classList.remove('visible');
    addLog(`undo: stashed ${data.stashed?.length || 0} file(s)`, 'ok');
  } catch (e) {
    showStatus('Undo failed: ' + e.message, 'error');
  }
}

// ─── Bridge events → log + UI state ───────────────────────────────────────────
function handleBridgeEvent(ev) {
  switch (ev.type) {
    case 'task_start':
      addLog(`▶ task started: ${ev.prompt || ''}`);
      $('sendBtn').disabled = true;
      $('sendBtnText').textContent = 'PROCESSING…';
      break;
    case 'task_progress':
      addLog(`  ⚙ ${ev.tool}${ev.detail ? ': ' + ev.detail.slice(0, 60) : ''}${ev.phase === 'verify' ? ' (verify)' : ''}`);
      break;
    case 'task_done': {
      $('sendBtn').disabled = false;
      setMode(mode); // restores the send button label
      if (ev.success) {
        addLog(`✓ done in ${ev.durationSec}s · ${ev.filesModified || 0} file(s)`, 'ok');
        showStatus(`✓ Completed in ${ev.durationSec}s\n${(ev.result || '').slice(0, 200)}`, 'success');
        if (ev.taskId === lastTaskId && ev.canUndo) $('taskActions').classList.add('visible');
      } else {
        addLog(`✗ failed: ${ev.error}`, 'err');
        showStatus(`✗ Error: ${ev.error}`, 'error');
      }
      checkBridgeStatus();
      break;
    }
    case 'verify_start':
      addLog('🔁 verifying: reloading page and re-capturing element…');
      break;
    case 'capture_request':
      addLog('  ⚙ capture requested by bridge');
      break;
    case 'verify_done':
      if (ev.success) {
        addLog(`🔁 verify done${ev.fixed ? ' — a fix was applied' : ' — change confirmed'}`, 'ok');
        if (ev.fixed) showStatus(`🔁 Self-check applied a fix:\n${(ev.result || '').slice(0, 200)}`, 'success');
      } else {
        addLog(`🔁 verify failed: ${ev.error}`, 'err');
      }
      break;
    case 'session_reset':
      addLog('session reset');
      break;
  }
}

function addLog(text, cls = '') {
  const panel = $('logPanel');
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toTimeString().slice(0, 8);
  line.appendChild(t);
  line.appendChild(document.createTextNode(text));
  panel.appendChild(line);
  while (panel.children.length > 200) panel.removeChild(panel.firstChild);
  panel.scrollTop = panel.scrollHeight;
}

// ─── Bridge status ────────────────────────────────────────────────────────────
function renderBridgeStatus(connected, detail) {
  $('bridgeDot').className = 'bridge-dot ' + (connected ? 'connected' : 'error');
  $('bridgeStatusText').textContent = detail || (connected ? 'bridge connected' : 'bridge offline');
}

async function checkBridgeStatus() {
  try {
    const res = await fetch(`${config.bridgeUrl}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(1500),
    });
    const data = await res.json();
    if (res.status === 401) {
      renderBridgeStatus(false, 'bridge up · bad token');
      return;
    }
    if (!res.ok) throw new Error();
    if (data.auth === 'token required') {
      renderBridgeStatus(false, 'bridge up · set token');
      return;
    }
    const busy = (data.sessions || []).some((s) => s.busy);
    renderBridgeStatus(true, busy ? 'bridge · working…' : `bridge · ${data.sessions?.length || 0} warm session(s)`);
  } catch {
    renderBridgeStatus(false, 'bridge offline');
  }
}

// ─── Status message ───────────────────────────────────────────────────────────
let statusTimer = null;
function showStatus(msg, type) {
  const el = $('status');
  el.className = `status ${type}`;
  el.textContent = msg;
  clearTimeout(statusTimer);
  if (type === 'success') statusTimer = setTimeout(() => { el.className = 'status'; }, 6000);
}

// ─── Color picker (DevTools-style, ported from the old popup) ─────────────────
const PALETTE = [
  '#000000', '#404040', '#737373', '#a3a3a3', '#d4d4d4', '#ffffff', '#141210', '#1d1b18', '#252220', '#2e2b27',
  '#CC785C', '#e8956d', '#b85a3f', '#7daa6e', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#ef4444', '#f87171',
  '#dc2626', '#b91c1c', '#f59e0b', '#fbbf24', '#eab308', '#ca8a04', '#d97706', '#b45309', '#3b82f6', '#60a5fa',
  '#2563eb', '#1d4ed8', '#6366f1', '#818cf8', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f472b6', '#0ea5e9',
];

function initColorPicker() {
  const btn = $('colorBtn');
  const panel = $('colorPanel');
  const svArea = $('svArea');
  const svThumb = $('svThumb');
  const hueTrack = $('hueTrack');
  const hueThumb = $('hueThumb');
  const alphaTrack = $('alphaTrack');
  const alphaThumb = $('alphaThumb');
  const preview = $('colorPreview');
  const hexInput = $('hexInput');
  const applyBtn = $('applyColorBtn');
  const pickBtn = $('pickFromPageBtn');
  const palette = $('colorPalette');

  let h = 18, s = 0.55, v = 0.80, a = 1;

  PALETTE.forEach((color) => {
    const sw = document.createElement('button');
    sw.className = 'palette-swatch';
    sw.style.background = color;
    sw.title = color.toUpperCase();
    sw.addEventListener('click', () => {
      const rgb = hexToRgb(color);
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      h = hsv.h; s = hsv.s; v = hsv.v; a = 1;
      render();
    });
    palette.appendChild(sw);
  });

  btn.addEventListener('click', () => panel.classList.toggle('open'));

  bindDrag(svArea, (x, y, rect) => {
    s = clamp01(x / rect.width);
    v = clamp01(1 - y / rect.height);
    render();
  });
  bindDrag(hueTrack, (x, _y, rect) => { h = clamp01(x / rect.width) * 360; render(); });
  bindDrag(alphaTrack, (x, _y, rect) => { a = clamp01(x / rect.width); render(); });

  hexInput.addEventListener('change', () => {
    const parsed = parseHex(hexInput.value.trim());
    if (parsed) {
      const hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
      h = hsv.h; s = hsv.s; v = hsv.v; a = parsed.a;
    }
    render();
  });

  applyBtn.addEventListener('click', () => {
    const ta = $('promptInput');
    const existing = ta.value.trim();
    ta.value = (existing ? existing + ' ' : 'Change the color to ') + currentHex();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    updateSendBtn();
    panel.classList.remove('open');
  });

  pickBtn.addEventListener('click', async () => {
    if (!window.EyeDropper) {
      showStatus('EyeDropper not supported in this browser', 'error');
      return;
    }
    try {
      const result = await new EyeDropper().open();
      const rgb = hexToRgb(result.sRGBHex);
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      h = hsv.h; s = hsv.s; v = hsv.v; a = 1;
      render();
    } catch { /* user cancelled */ }
  });

  function currentHex() {
    const { r, g, b } = hsvToRgb(h, s, v);
    return a < 1 ? rgbaToHex8(r, g, b, a) : rgbToHex(r, g, b);
  }

  function render() {
    const { r, g, b } = hsvToRgb(h, s, v);
    const hueRgb = hsvToRgb(h, 1, 1);
    svArea.style.background = `
      linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, transparent),
      rgb(${hueRgb.r}, ${hueRgb.g}, ${hueRgb.b})
    `;
    svThumb.style.left = (s * 100) + '%';
    svThumb.style.top = ((1 - v) * 100) + '%';
    hueThumb.style.left = (h / 360 * 100) + '%';
    alphaTrack.style.setProperty('--alpha-gradient',
      `linear-gradient(to right, rgba(${r},${g},${b},0), rgba(${r},${g},${b},1))`);
    alphaThumb.style.left = (a * 100) + '%';
    preview.style.setProperty('--current-color', `rgba(${r},${g},${b},${a})`);
    if (document.activeElement !== hexInput) hexInput.value = currentHex().toUpperCase();
  }

  function bindDrag(el, onMove) {
    const move = (e) => {
      const rect = el.getBoundingClientRect();
      const point = e.touches ? e.touches[0] : e;
      const x = clamp(point.clientX - rect.left, 0, rect.width);
      const y = clamp(point.clientY - rect.top, 0, rect.height);
      onMove(x, y, rect);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    el.addEventListener('mousedown', (e) => {
      move(e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  render();
}

// ─── Color math ───────────────────────────────────────────────────────────────
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function clamp01(n) { return clamp(n, 0, 1); }

function hsvToRgb(h, s, v) {
  const c = v * s;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs(hh % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  if (m.length === 3) return { r: parseInt(m[0] + m[0], 16), g: parseInt(m[1] + m[1], 16), b: parseInt(m[2] + m[2], 16), a: 1 };
  if (m.length === 6) return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16), a: 1 };
  if (m.length === 8) return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16), a: parseInt(m.slice(6, 8), 16) / 255 };
  return null;
}

function parseHex(str) {
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(str)) return null;
  return hexToRgb(str.startsWith('#') ? str : '#' + str);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function rgbaToHex8(r, g, b, a) {
  return rgbToHex(r, g, b) + Math.round(a * 255).toString(16).padStart(2, '0');
}
