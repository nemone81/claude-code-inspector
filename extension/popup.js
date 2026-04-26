// Claude Code Inspector - Popup JS

let currentElement = null;
let mode = 'oneshot'; // 'oneshot' | 'clipboard'
let config = {
  projectPath: '',
  bridgeUrl: 'http://localhost:3131'
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadSelectedElement();
  checkBridgeStatus();
  bindEvents();
});

async function loadConfig() {
  const saved = await chrome.storage.local.get(['config', 'mode']);
  if (saved.config) config = { ...config, ...saved.config };
  if (saved.mode) mode = saved.mode;

  document.getElementById('projectPath').value = config.projectPath;
  document.getElementById('bridgeUrl').value = config.bridgeUrl;
  setMode(mode);
}

async function loadSelectedElement() {
  // Try the background first (last fresh selection)
  const res = await chrome.runtime.sendMessage({ action: 'getSelectedElement' });
  if (res?.info) {
    showElement(res.info);
    return;
  }

  // Fall back to the active tab's content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getInspectorState' });
      if (response?.selected) showElement(response.selected);
    } catch (e) {
      // content script not injected yet, that's fine
    }
  }
}

function bindEvents() {
  // Mode toggle
  document.getElementById('modeOneshot').addEventListener('click', () => setMode('oneshot'));
  document.getElementById('modeClipboard').addEventListener('click', () => setMode('clipboard'));

  // Config
  document.getElementById('configToggle').addEventListener('click', () => {
    document.getElementById('configPanel').classList.toggle('open');
  });

  document.getElementById('saveConfig').addEventListener('click', saveConfig);

  // Inspector
  document.getElementById('inspectBtn').addEventListener('click', toggleInspector);

  // Clear element
  document.getElementById('clearElement').addEventListener('click', clearElement);

  // Quick prompts (excludes colorBtn, which has its own logic)
  document.querySelectorAll('.quick-btn[data-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ta = document.getElementById('promptInput');
      ta.value = btn.dataset.prompt + ' ';
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  });

  // Color picker
  initColorPicker();

  // Prompt input → abilita send
  document.getElementById('promptInput').addEventListener('input', updateSendBtn);

  // Send
  document.getElementById('sendBtn').addEventListener('click', sendToClaude);

  // Listen for element selected from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'elementSelected') {
      showElement(msg.info);
    }
  });
}

// ─── Color picker (DevTools-style) ────────────────────────────────────────────
const PALETTE = [
  '#000000', '#404040', '#737373', '#a3a3a3', '#d4d4d4', '#ffffff', '#141210', '#1d1b18', '#252220', '#2e2b27',
  '#CC785C', '#e8956d', '#b85a3f', '#7daa6e', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#ef4444', '#f87171',
  '#dc2626', '#b91c1c', '#f59e0b', '#fbbf24', '#eab308', '#ca8a04', '#d97706', '#b45309', '#3b82f6', '#60a5fa',
  '#2563eb', '#1d4ed8', '#6366f1', '#818cf8', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f472b6', '#0ea5e9',
];

function initColorPicker() {
  const btn = document.getElementById('colorBtn');
  const panel = document.getElementById('colorPanel');
  const svArea = document.getElementById('svArea');
  const svThumb = document.getElementById('svThumb');
  const hueTrack = document.getElementById('hueTrack');
  const hueThumb = document.getElementById('hueThumb');
  const alphaTrack = document.getElementById('alphaTrack');
  const alphaThumb = document.getElementById('alphaThumb');
  const preview = document.getElementById('colorPreview');
  const hexInput = document.getElementById('hexInput');
  const applyBtn = document.getElementById('applyColorBtn');
  const pickBtn = document.getElementById('pickFromPageBtn');
  const palette = document.getElementById('colorPalette');

  // Stato HSVA (h: 0-360, s/v: 0-1, a: 0-1)
  let h = 18, s = 0.55, v = 0.80, a = 1;

  // Inizializzazione palette
  PALETTE.forEach(color => {
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

  // SV area drag
  bindDrag(svArea, (x, y, rect) => {
    s = clamp01(x / rect.width);
    v = clamp01(1 - y / rect.height);
    render();
  });

  // Hue slider
  bindDrag(hueTrack, (x, _y, rect) => {
    h = clamp01(x / rect.width) * 360;
    render();
  });

  // Alpha slider
  bindDrag(alphaTrack, (x, _y, rect) => {
    a = clamp01(x / rect.width);
    render();
  });

  // Hex input
  hexInput.addEventListener('change', () => {
    const parsed = parseHex(hexInput.value.trim());
    if (parsed) {
      const hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
      h = hsv.h; s = hsv.s; v = hsv.v; a = parsed.a;
      render();
    } else {
      render(); // restore the previous value
    }
  });

  applyBtn.addEventListener('click', () => {
    const ta = document.getElementById('promptInput');
    const existing = ta.value.trim();
    const prefix = existing ? existing + ' ' : 'Change the color to ';
    ta.value = prefix + currentHex();
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
    if (a < 1) return rgbaToHex8(r, g, b, a);
    return rgbToHex(r, g, b);
  }

  function render() {
    const { r, g, b } = hsvToRgb(h, s, v);
    const hex = currentHex();

    // SV background = hue puro
    const hueRgb = hsvToRgb(h, 1, 1);
    svArea.style.background = `
      linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, transparent),
      rgb(${hueRgb.r}, ${hueRgb.g}, ${hueRgb.b})
    `;

    // SV thumb
    svThumb.style.left = (s * 100) + '%';
    svThumb.style.top = ((1 - v) * 100) + '%';

    // Hue thumb
    hueThumb.style.left = (h / 360 * 100) + '%';

    // Alpha track gradient + thumb
    alphaTrack.style.setProperty('--alpha-gradient',
      `linear-gradient(to right, rgba(${r},${g},${b},0), rgba(${r},${g},${b},1))`);
    alphaThumb.style.left = (a * 100) + '%';

    // Preview
    preview.style.setProperty('--current-color', `rgba(${r},${g},${b},${a})`);

    // Hex input (non sovrascrivere se l'utente sta digitando)
    if (document.activeElement !== hexInput) hexInput.value = hex.toUpperCase();
  }

  function bindDrag(el, onMove) {
    const move = e => {
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
    el.addEventListener('mousedown', e => {
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
  const s = max ? d / max : 0;
  return { h, s, v: max };
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  if (m.length === 3) {
    return { r: parseInt(m[0]+m[0], 16), g: parseInt(m[1]+m[1], 16), b: parseInt(m[2]+m[2], 16), a: 1 };
  }
  if (m.length === 6) {
    return { r: parseInt(m.slice(0,2), 16), g: parseInt(m.slice(2,4), 16), b: parseInt(m.slice(4,6), 16), a: 1 };
  }
  if (m.length === 8) {
    return { r: parseInt(m.slice(0,2), 16), g: parseInt(m.slice(2,4), 16), b: parseInt(m.slice(4,6), 16), a: parseInt(m.slice(6,8), 16) / 255 };
  }
  return null;
}

function parseHex(str) {
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(str)) return null;
  return hexToRgb(str.startsWith('#') ? str : '#' + str);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

function rgbaToHex8(r, g, b, a) {
  return rgbToHex(r, g, b) + Math.round(a * 255).toString(16).padStart(2, '0');
}

// ─── Mode ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  chrome.storage.local.set({ mode });

  document.getElementById('modeOneshot').classList.toggle('active', m === 'oneshot');
  document.getElementById('modeClipboard').classList.toggle('active', m === 'clipboard');

  const btn = document.getElementById('sendBtnText');
  btn.textContent = m === 'oneshot' ? 'SEND TO CLAUDE' : 'COPY TO CLIPBOARD';
}

// ─── Config ───────────────────────────────────────────────────────────────────
async function saveConfig() {
  config.projectPath = document.getElementById('projectPath').value.trim();
  config.bridgeUrl = document.getElementById('bridgeUrl').value.trim() || 'http://localhost:3131';
  await chrome.storage.local.set({ config });
  document.getElementById('configPanel').classList.remove('open');
  showStatus('Configuration saved ✓', 'success');
  checkBridgeStatus();
}

// ─── Inspector toggle ─────────────────────────────────────────────────────────
async function toggleInspector() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const btn = document.getElementById('inspectBtn');
  const btnText = document.getElementById('inspectBtnText');

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'toggleInspector' });
    if (res?.active) {
      btn.classList.add('active');
      btnText.textContent = 'Inspector active — click an element';
      window.close(); // close popup so the page becomes interactive
    } else {
      btn.classList.remove('active');
      btnText.textContent = 'Select element';
    }
  } catch (e) {
    // The content script may not be injected yet — inject it manually
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
    // Retry
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleInspector' });
    window.close();
  }
}

// ─── Element display ──────────────────────────────────────────────────────────
function showElement(info) {
  currentElement = info;

  const preview = document.getElementById('elementPreview');
  preview.classList.add('visible');

  document.getElementById('previewTag').textContent = `<${info.tag}>`;
  document.getElementById('previewSelector').textContent = info.selector;

  // HTML preview (sintassi colorata basic)
  const html = info.html.length > 300 ? info.html.slice(0, 300) + '…' : info.html;
  document.getElementById('previewHtml').textContent = html;

  // Meta chips
  const meta = document.getElementById('previewMeta');
  meta.innerHTML = '';

  const chips = [];
  if (info.dimensions.width) chips.push(`${info.dimensions.width}×${info.dimensions.height}px`);
  if (info.styles.display) chips.push(`display:${info.styles.display}`);
  if (info.styles.fontSize) chips.push(`${info.styles.fontSize}`);
  if (info.classes.length) chips.push(`.${info.classes.slice(0,2).join('.')}`);

  chips.forEach(c => {
    const chip = document.createElement('span');
    chip.className = 'meta-chip';
    chip.textContent = c;
    meta.appendChild(chip);
  });

  updateSendBtn();
}

function clearElement() {
  currentElement = null;
  document.getElementById('elementPreview').classList.remove('visible');
  chrome.runtime.sendMessage({ action: 'clearSelectedElement' });
  updateSendBtn();
}

function updateSendBtn() {
  const prompt = document.getElementById('promptInput').value.trim();
  document.getElementById('sendBtn').disabled = !prompt;
}

// ─── Build prompt message ─────────────────────────────────────────────────────
function buildMessage(prompt, elementInfo) {
  let msg = prompt;

  if (elementInfo) {
    msg += `\n\n---\nSELECTED ELEMENT:\n`;
    msg += `Tag: <${elementInfo.tag}>\n`;
    msg += `CSS selector: ${elementInfo.selector}\n`;
    if (elementInfo.id) msg += `ID: #${elementInfo.id}\n`;
    if (elementInfo.classes.length) msg += `Classes: ${elementInfo.classes.join(', ')}\n`;
    msg += `Dimensions: ${elementInfo.dimensions.width}×${elementInfo.dimensions.height}px\n`;
    msg += `Computed styles: font-size=${elementInfo.styles.fontSize}, color=${elementInfo.styles.color}, bg=${elementInfo.styles.backgroundColor}\n`;
    msg += `\nHTML:\n${elementInfo.html.slice(0, 800)}\n`;
    msg += `\nPage: ${elementInfo.pageUrl}\n`;
    msg += `---`;
  }

  return msg;
}

// ─── Send ─────────────────────────────────────────────────────────────────────
async function sendToClaude() {
  const prompt = document.getElementById('promptInput').value.trim();
  if (!prompt) return;

  const message = buildMessage(prompt, currentElement);
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;

  if (mode === 'clipboard') {
    await sendViaClipboard(message);
  } else {
    await sendViaBridge(message);
  }
}

async function sendViaClipboard(message) {
  try {
    await navigator.clipboard.writeText(message);
    showStatus('✓ Copied to clipboard!\nSwitch to your terminal and press Cmd+V → Enter', 'success');
  } catch (e) {
    showStatus('Failed to copy: ' + e.message, 'error');
  }
}

async function sendViaBridge(message) {
  const bridgeUrl = config.bridgeUrl || 'http://localhost:3131';

  try {
    const res = await fetch(`${bridgeUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: message,
        projectPath: config.projectPath
      })
    });

    if (!res.ok) throw new Error(`Bridge error: ${res.status}`);

    const data = await res.json();
    showStatus(`✓ Sent to Claude Code!\n${data.message || ''}`, 'success');

  } catch (e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      showStatus('Bridge unreachable.\nStart the bridge with:\n  cd bridge && node server.js', 'error');
    } else {
      showStatus('Error: ' + e.message, 'error');
    }
    // Auto-fallback to clipboard
    await sendViaClipboard(message);
  }
}

// ─── Bridge status ────────────────────────────────────────────────────────────
async function checkBridgeStatus() {
  const dot = document.getElementById('bridgeDot');
  const txt = document.getElementById('bridgeStatusText');
  const resetBtn = document.getElementById('resetSessionBtn');
  const bridgeUrl = config.bridgeUrl || 'http://localhost:3131';

  try {
    const res = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      dot.className = 'bridge-dot connected';
      const sessionInfo = data.sessionId ? `session ${data.sessionId}` : 'new session';
      txt.textContent = `bridge · ${sessionInfo}`;
      resetBtn.style.display = data.sessionId ? 'block' : 'none';
    } else {
      throw new Error();
    }
  } catch {
    dot.className = 'bridge-dot error';
    txt.textContent = 'bridge offline · clipboard fallback';
    resetBtn.style.display = 'none';
  }
}

document.getElementById('resetSessionBtn')?.addEventListener('click', async () => {
  const bridgeUrl = config.bridgeUrl || 'http://localhost:3131';
  try {
    await fetch(`${bridgeUrl}/reset`, { method: 'POST' });
    showStatus('Session reset ✓\nThe next request will start a fresh session', 'success');
    checkBridgeStatus();
  } catch {
    showStatus('Bridge unreachable', 'error');
  }
});

// ─── Status message ───────────────────────────────────────────────────────────
function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.className = `status ${type}`;
  el.textContent = msg;
  if (type === 'success') {
    setTimeout(() => { el.className = 'status'; }, 4000);
  }
  document.getElementById('sendBtn').disabled = false;
}

// ─── SSE events dal background ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'sseStatus') {
    const dot = document.getElementById('bridgeDot');
    const txt = document.getElementById('bridgeStatusText');
    if (!msg.connected) {
      dot.className = 'bridge-dot error';
      txt.textContent = 'bridge offline · reconnecting…';
    }
  }

  if (msg.action === 'sseEvent') {
    const { eventName, data } = msg;
    if (eventName === 'task_start') {
      showStatus('⏳ Claude is working…', 'success');
      document.getElementById('sendBtn').disabled = true;
      document.getElementById('sendBtnText').textContent = 'PROCESSING…';
    }
    if (eventName === 'task_progress') {
      showStatus(`⚙ ${data.tool}${data.detail ? ': ' + data.detail.slice(0, 50) : ''}`, 'success');
    }
    if (eventName === 'task_done') {
      const sendBtn = document.getElementById('sendBtn');
      const sendBtnText = document.getElementById('sendBtnText');
      sendBtn.disabled = false;
      sendBtnText.textContent = mode === 'oneshot' ? 'SEND TO CLAUDE' : 'COPY TO CLIPBOARD';
      if (data.success) {
        showStatus(`✓ Completed in ${data.durationSec}s\n${(data.result || '').slice(0, 200)}`, 'success');
      } else {
        showStatus(`✗ Error: ${data.error}`, 'error');
      }
      checkBridgeStatus();
    }
  }
});
