// Claude Code Inspector - Content Script
// Visual element inspector injected into every page

let inspectorActive = false;
let hoveredElement = null;
let selectedElement = null;
let overlay = null;
let tooltip = null;

// ─── Toggle inspector ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'toggleInspector') {
    inspectorActive ? deactivateInspector() : activateInspector();
    sendResponse({ active: inspectorActive });
  }
  if (msg.action === 'getInspectorState') {
    sendResponse({ active: inspectorActive, selected: selectedElement ? getElementInfo(selectedElement) : null });
  }
  if (msg.action === 'taskResult') {
    showTaskBanner(msg.data);
  }
});

function activateInspector() {
  inspectorActive = true;
  createOverlay();
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.body.style.cursor = 'crosshair';
  showToast('Inspector active — click an element');
}

function deactivateInspector() {
  inspectorActive = false;
  removeOverlay();
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mouseout', onMouseOut, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.body.style.cursor = '';
  hoveredElement = null;
}

// ─── Highlight overlay ────────────────────────────────────────────────────────
function createOverlay() {
  overlay = document.createElement('div');
  overlay.id = '__claude_inspector_overlay__';
  document.body.appendChild(overlay);

  tooltip = document.createElement('div');
  tooltip.id = '__claude_inspector_tooltip__';
  document.body.appendChild(tooltip);
}

function removeOverlay() {
  overlay?.remove();
  tooltip?.remove();
  overlay = null;
  tooltip = null;
}

function highlightElement(el) {
  if (!el || !overlay) return;
  const rect = el.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  overlay.style.cssText = `
    position: absolute;
    top: ${rect.top + scrollY}px;
    left: ${rect.left + scrollX}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    pointer-events: none;
    z-index: 2147483646;
    box-sizing: border-box;
    outline: 2px solid #CC785C;
    background: rgba(204, 120, 92, 0.12);
    transition: all 0.08s ease;
  `;

  // Tooltip with tag + class
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  tooltip.textContent = `${tag}${id}${cls}`;

  const tipX = rect.left + scrollX;
  const tipY = rect.top + scrollY - 26;
  tooltip.style.cssText = `
    position: absolute;
    top: ${tipY < scrollY ? rect.bottom + scrollY + 4 : tipY}px;
    left: ${tipX}px;
    background: #1a1a1a;
    color: #CC785C;
    font: 11px/1 'SF Mono', monospace;
    padding: 4px 8px;
    border-radius: 4px;
    pointer-events: none;
    z-index: 2147483647;
    white-space: nowrap;
    letter-spacing: 0.02em;
  `;
}

// ─── Event handlers ───────────────────────────────────────────────────────────
function onMouseOver(e) {
  if (!inspectorActive) return;
  const el = e.target;
  if (el.id === '__claude_inspector_overlay__' || el.id === '__claude_inspector_tooltip__') return;
  hoveredElement = el;
  highlightElement(el);
}

function onMouseOut(e) {
  if (!inspectorActive) return;
  if (overlay) overlay.style.outline = '2px solid #CC785C';
}

function onClick(e) {
  if (!inspectorActive) return;
  e.preventDefault();
  e.stopPropagation();

  selectedElement = e.target;
  deactivateInspector();

  const info = getElementInfo(selectedElement);

  // Notify the popup that an element has been selected
  chrome.runtime.sendMessage({ action: 'elementSelected', info });

  showToast('Element selected ✓');
}

function onKeyDown(e) {
  if (e.key === 'Escape') deactivateInspector();
}

// ─── Element info extraction ──────────────────────────────────────────────────
function getElementInfo(el) {
  const rect = el.getBoundingClientRect();
  const styles = window.getComputedStyle(el);

  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
    selector: getCssSelector(el),
    xpath: getXPath(el),
    html: el.outerHTML.slice(0, 2000), // max 2kb
    innerText: el.innerText?.slice(0, 500) || '',
    dimensions: {
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    styles: {
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      fontSize: styles.fontSize,
      fontFamily: styles.fontFamily,
      display: styles.display,
      position: styles.position,
      padding: styles.padding,
      margin: styles.margin,
      borderRadius: styles.borderRadius
    },
    pageUrl: window.location.href
  };
}

function getCssSelector(el) {
  if (el.id) return `#${el.id}`;

  const parts = [];
  let current = el;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector = `#${current.id}`;
      parts.unshift(selector);
      break;
    }

    const classes = Array.from(current.classList).slice(0, 2);
    if (classes.length) selector += '.' + classes.join('.');

    // nth-child when needed
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(s => s.tagName === current.tagName)
      : [];
    if (siblings.length > 1) {
      const idx = siblings.indexOf(current) + 1;
      selector += `:nth-of-type(${idx})`;
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function getXPath(el) {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sib = current.previousSibling;
    while (sib) {
      if (sib.nodeType === Node.ELEMENT_NODE && sib.tagName === current.tagName) idx++;
      sib = sib.previousSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentNode;
  }
  return '/' + parts.join('/');
}

// ─── Toast notification ───────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1a1a1a;
    color: #f0ece4;
    font: 13px/1.4 'SF Mono', monospace;
    padding: 10px 16px;
    border-radius: 8px;
    z-index: 2147483647;
    border-left: 3px solid #CC785C;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    animation: claudeToastIn 0.2s ease;
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes claudeToastIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }`;
  document.head.appendChild(style);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ─── Task result banner (persistent) ──────────────────────────────────────────
function showTaskBanner(data) {
  document.getElementById('__claude_task_banner__')?.remove();

  const success = !!data.success;
  const banner = document.createElement('div');
  banner.id = '__claude_task_banner__';
  banner.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    max-width: 420px;
    background: #1a1a1a;
    color: #f0ece4;
    font: 13px/1.45 -apple-system, 'SF Pro Text', system-ui, sans-serif;
    padding: 14px 16px 12px;
    border-radius: 10px;
    z-index: 2147483647;
    border-left: 3px solid ${success ? '#4ade80' : '#f87171'};
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    animation: claudeBannerIn 0.25s ease;
  `;

  const title = success ? '✓ Task completed' : '✗ Task failed';
  const filesInfo = data.filesModified > 0 ? ` · ${data.filesModified} files modified` : '';
  const meta = success
    ? `⏱ ${data.durationSec}s${filesInfo}`
    : '';
  const body = success
    ? (data.result || 'Changes applied')
    : (data.error || 'Unknown error');

  banner.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:8px;">
      <div style="font-weight:600; font-size:13px;">${escapeHtml(title)}</div>
      <button id="__claude_banner_close__" style="background:none; border:none; color:#888; cursor:pointer; font-size:18px; padding:0; line-height:1;">×</button>
    </div>
    <div style="font-size:12px; color:#d4d0c8; white-space:pre-wrap; word-break:break-word; max-height:120px; overflow-y:auto;">${escapeHtml(body)}</div>
    ${meta ? `<div style="font-size:11px; color:#888; margin-top:8px;">${escapeHtml(meta)}</div>` : ''}
    ${success ? `<button id="__claude_banner_reload__" style="margin-top:10px; background:#CC785C; color:#fff; border:none; padding:7px 14px; border-radius:6px; font:500 12px/1 -apple-system,sans-serif; cursor:pointer; width:100%;">↻ Reload without cache</button>` : ''}
  `;

  if (!document.getElementById('__claude_banner_style__')) {
    const style = document.createElement('style');
    style.id = '__claude_banner_style__';
    style.textContent = `@keyframes claudeBannerIn { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(banner);

  banner.querySelector('#__claude_banner_close__').addEventListener('click', () => banner.remove());
  banner.querySelector('#__claude_banner_reload__')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'reloadTabNoCache' });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
