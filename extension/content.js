// Claude Code Inspector — Content Script (v4)
// Injected on demand (never declared in the manifest). A window guard makes
// re-injection a no-op so listeners are never duplicated.

(() => {
  if (window.__claudeInspectorLoaded__) return;
  window.__claudeInspectorLoaded__ = true;

  let inspectorActive = false;
  let multiMode = false;
  let selectedElements = []; // DOM nodes picked in this round
  let overlay = null;
  let tooltip = null;

  // ─── Messages ───────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'toggleInspector') {
      if (inspectorActive) deactivateInspector();
      else activateInspector(!!msg.multi);
      sendResponse({ active: inspectorActive });
    }
    if (msg.action === 'getInspectorState') {
      sendResponse({ active: inspectorActive });
    }
    if (msg.action === 'captureBySelector') {
      let el = null;
      try { el = document.querySelector(msg.selector); } catch { /* bad selector */ }
      sendResponse({
        element: el ? getElementInfo(el) : null,
        dpr: window.devicePixelRatio || 1,
      });
    }
    if (msg.action === 'taskResult') {
      showTaskBanner(msg.data);
    }
  });

  // ─── Inspector ──────────────────────────────────────────────────────────────
  function activateInspector(multi) {
    inspectorActive = true;
    multiMode = multi;
    selectedElements = [];
    createOverlay();
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.style.cursor = 'crosshair';
    showToast(multi
      ? 'Multi-select active — click elements, Enter/Esc to finish'
      : 'Inspector active — click an element');
  }

  function deactivateInspector() {
    inspectorActive = false;
    removeOverlay();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.body.style.cursor = '';
  }

  function finishSelection() {
    const elements = selectedElements.map(getElementInfo);
    deactivateInspector();
    if (!elements.length) return;
    chrome.runtime.sendMessage({
      action: 'elementsSelected',
      elements,
      pageUrl: window.location.href,
      dpr: window.devicePixelRatio || 1,
    });
    showToast(`${elements.length} element${elements.length > 1 ? 's' : ''} selected ✓`);
  }

  function onClick(e) {
    if (!inspectorActive) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (isInspectorNode(el)) return;
    if (!selectedElements.includes(el)) {
      selectedElements.push(el);
      markSelected(el);
    }
    if (multiMode) {
      showToast(`${selectedElements.length} selected — Enter to finish`);
    } else {
      finishSelection();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (multiMode && selectedElements.length) finishSelection();
      else deactivateInspector();
    }
    if (e.key === 'Enter' && multiMode) {
      e.preventDefault();
      finishSelection();
    }
  }

  function onMouseOver(e) {
    if (!inspectorActive) return;
    if (isInspectorNode(e.target)) return;
    highlightElement(e.target);
  }

  function isInspectorNode(el) {
    return el.id === '__claude_inspector_overlay__' || el.id === '__claude_inspector_tooltip__';
  }

  // ─── Highlight overlay ──────────────────────────────────────────────────────
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
    document.querySelectorAll('.__claude_selected_mark__').forEach((n) => {
      n.classList.remove('__claude_selected_mark__');
    });
  }

  function markSelected(el) {
    el.classList.add('__claude_selected_mark__');
  }

  function highlightElement(el) {
    if (!el || !overlay) return;
    const rect = el.getBoundingClientRect();
    const { scrollX, scrollY } = window;

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

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const src = detectSource(el);
    tooltip.textContent = `${tag}${id}${cls}${src?.fileName ? ' · ' + shortFile(src.fileName) : ''}`;

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

  function shortFile(f) {
    return f.split('/').slice(-2).join('/');
  }

  // ─── DOM → source (React/Vue dev builds) ────────────────────────────────────
  function detectSource(el) {
    // React: dev builds attach a fiber with _debugSource (file + line).
    try {
      for (const key in el) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = el[key];
          let componentName = null;
          let hops = 0;
          while (fiber && hops++ < 50) {
            if (!componentName && typeof fiber.type === 'function') {
              componentName = fiber.type.displayName || fiber.type.name || null;
            }
            const src = fiber._debugSource;
            if (src && src.fileName) {
              return {
                framework: 'React',
                fileName: src.fileName,
                lineNumber: src.lineNumber || null,
                componentName,
              };
            }
            fiber = fiber._debugOwner || fiber.return;
          }
          if (componentName) return { framework: 'React', fileName: null, componentName };
          break;
        }
      }
    } catch { /* ignore */ }

    // Vue 3: __vueParentComponent → component type carries __file in dev.
    try {
      const comp = el.__vueParentComponent;
      if (comp && comp.type) {
        return {
          framework: 'Vue',
          fileName: comp.type.__file || null,
          lineNumber: null,
          componentName: comp.type.name || comp.type.__name || null,
        };
      }
    } catch { /* ignore */ }

    // Vue 2: __vue__ instance with $options.__file.
    try {
      let vm = el.__vue__;
      let hops = 0;
      while (vm && hops++ < 20) {
        if (vm.$options && vm.$options.__file) {
          return {
            framework: 'Vue',
            fileName: vm.$options.__file,
            lineNumber: null,
            componentName: vm.$options.name || null,
          };
        }
        vm = vm.$parent;
      }
    } catch { /* ignore */ }

    return null;
  }

  // ─── Element info extraction ────────────────────────────────────────────────
  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);

    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter((c) => c && c !== '__claude_selected_mark__')
        : [],
      selector: getCssSelector(el),
      xpath: getXPath(el),
      source: detectSource(el),
      html: el.outerHTML.slice(0, 2000),
      innerText: el.innerText?.slice(0, 500) || '',
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      dimensions: { width: Math.round(rect.width), height: Math.round(rect.height) },
      styles: {
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        fontSize: styles.fontSize,
        fontFamily: styles.fontFamily,
        display: styles.display,
        position: styles.position,
        padding: styles.padding,
        margin: styles.margin,
        borderRadius: styles.borderRadius,
      },
      pageUrl: window.location.href,
    };
  }

  function getCssSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const classes = Array.from(current.classList)
        .filter((c) => c !== '__claude_selected_mark__')
        .slice(0, 2);
      if (classes.length) selector += '.' + classes.map((c) => CSS.escape(c)).join('.');
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((s) => s.tagName === current.tagName)
        : [];
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
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

  // ─── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg) {
    document.getElementById('__claude_inspector_toast__')?.remove();
    const toast = document.createElement('div');
    toast.id = '__claude_inspector_toast__';
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
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  // ─── Task result banner ─────────────────────────────────────────────────────
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
    `;

    const title = success ? '✓ Task completed' : '✗ Task failed';
    const filesInfo = data.filesModified > 0 ? ` · ${data.filesModified} files modified` : '';
    const meta = success ? `⏱ ${data.durationSec || '?'}s${filesInfo}` : '';
    const body = success ? (data.result || 'Changes applied') : (data.error || 'Unknown error');

    banner.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:8px;">
        <div style="font-weight:600; font-size:13px;">${escapeHtml(title)}</div>
        <button id="__claude_banner_close__" style="background:none; border:none; color:#888; cursor:pointer; font-size:18px; padding:0; line-height:1;">×</button>
      </div>
      <div style="font-size:12px; color:#d4d0c8; white-space:pre-wrap; word-break:break-word; max-height:120px; overflow-y:auto;">${escapeHtml(body)}</div>
      ${meta ? `<div style="font-size:11px; color:#888; margin-top:8px;">${escapeHtml(meta)}</div>` : ''}
      ${success ? '<button id="__claude_banner_reload__" style="margin-top:10px; background:#CC785C; color:#fff; border:none; padding:7px 14px; border-radius:6px; font:500 12px/1 -apple-system,sans-serif; cursor:pointer; width:100%;">↻ Reload without cache</button>' : ''}
    `;

    document.body.appendChild(banner);
    banner.querySelector('#__claude_banner_close__').addEventListener('click', () => banner.remove());
    banner.querySelector('#__claude_banner_reload__')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'reloadTabNoCache' });
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
