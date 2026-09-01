// Claude Code Inspector — Background Service Worker (v4)
// WebSocket connection to the bridge (an active WS keeps the MV3 service
// worker alive on Chrome 116+, no alarms needed), element capture for the
// verification loop, screenshot cropping.

let config = { bridgeUrl: 'http://localhost:3131', token: '', projectPath: '' };
let ws = null;
let wsConnected = false;
let reconnectTimer = null;

// Last selection made in the page, plus the tab it came from.
let selection = null; // { elements, screenshots, pageUrl, tabId }

// ─── Bootstrap ────────────────────────────────────────────────────────────────
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function loadConfig() {
  const saved = await chrome.storage.local.get(['config']);
  if (saved.config) config = { ...config, ...saved.config };
}

loadConfig().then(connectWS);
chrome.runtime.onStartup.addListener(() => loadConfig().then(connectWS));
chrome.runtime.onInstalled.addListener((details) => {
  loadConfig().then(connectWS);
  // First install: open the setup guide.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
  }
});

// ─── WebSocket to the bridge ──────────────────────────────────────────────────
function wsUrl() {
  const base = (config.bridgeUrl || 'http://localhost:3131').replace(/^http/, 'ws').replace(/\/$/, '');
  return `${base}/ws?token=${encodeURIComponent(config.token || '')}`;
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    console.log('[WS] Connected');
    broadcastToPanel({ action: 'bridgeStatus', connected: true });
    // Re-announce the current selection so the bridge (and MCP tool) has it.
    if (selection) sendSelectionToBridge();
    // Companion: announce this browser profile with a full snapshot.
    sendCompanionSnapshot(true);
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleBridgeEvent(msg);
  };

  ws.onclose = () => {
    wsConnected = false;
    ws = null;
    broadcastToPanel({ action: 'bridgeStatus', connected: false });
    scheduleReconnect();
  };

  ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 3000);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function sendSelectionToBridge() {
  if (!selection) return;
  // Strip screenshots: the bridge only needs the structured info (for MCP).
  wsSend({ type: 'selection', elements: selection.elements, pageUrl: selection.pageUrl });
}

// ─── Events from the bridge ───────────────────────────────────────────────────
function handleBridgeEvent(msg) {
  switch (msg.type) {
    case 'task_start':
      showNotification(msg.taskId, '⏳ Claude is working…', truncate(msg.prompt, 80), 0);
      chrome.action.setBadgeText({ text: '…' });
      chrome.action.setBadgeBackgroundColor({ color: '#CC785C' });
      break;

    case 'task_progress':
      chrome.notifications.update(msg.taskId, {
        message: `⚙ ${msg.tool}${msg.detail ? ': ' + truncate(msg.detail, 50) : ''}`,
      }).catch?.(() => {});
      break;

    case 'task_done': {
      chrome.action.setBadgeText({ text: '' });
      chrome.notifications.clear(msg.taskId);
      if (msg.success) {
        const filesInfo = msg.filesModified > 0 ? ` · ${msg.filesModified} files modified` : '';
        showNotification(
          msg.taskId + '_done',
          '✓ Claude completed the task',
          truncate(msg.result || 'Changes applied', 120) + `\n\n⏱ ${msg.durationSec}s${filesInfo}`,
          2, true
        );
      } else {
        showNotification(msg.taskId + '_err', '✗ Task failed', truncate(msg.error || 'Unknown error', 150), 2, true);
      }
      // Banner goes to the tab the prompt came from, not whatever is active now.
      sendBannerToTab(msg.tabId, msg);
      break;
    }

    case 'verify_done':
      if (msg.success && msg.fixed) {
        showNotification(msg.taskId + '_verify', '🔁 Self-check applied a fix', truncate(msg.result, 120), 2, true);
        sendBannerToTab(msg.tabId, { ...msg, filesModified: undefined });
      }
      break;

    case 'session_reset':
      chrome.action.setBadgeText({ text: '' });
      break;

    case 'capture_request':
      handleCaptureRequest(msg);
      return; // handled asynchronously; still forward below for panel logging

    case 'focus_request':
      handleFocusRequest();
      return;
  }

  broadcastToPanel({ action: 'bridgeEvent', event: msg });
}

// ─── Verification: reload + re-capture an element on request ──────────────────
async function handleCaptureRequest({ requestId, tabId, selector, screenshot }) {
  broadcastToPanel({ action: 'bridgeEvent', event: { type: 'capture_request', requestId, tabId } });
  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
    await waitForTabLoad(tabId, 20000);
    await injectContentScript(tabId);

    const res = await chrome.tabs.sendMessage(tabId, { action: 'captureBySelector', selector });
    if (!res?.element) {
      wsSend({ type: 'capture_response', requestId, element: null });
      return;
    }

    let shot = null;
    if (screenshot) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        shot = await captureElementShot(tab.windowId, res.element.rect, res.dpr);
      } catch (e) {
        console.log('[capture] screenshot failed:', e.message);
      }
    }

    wsSend({ type: 'capture_response', requestId, element: res.element, screenshot: shot });
  } catch (err) {
    wsSend({ type: 'capture_response', requestId, error: err.message });
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('tab load timed out'));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // small settle delay for SPA hydration
        setTimeout(resolve, 800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectContentScript(tabId) {
  // Idempotent: content.js ignores re-injection via a window guard.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
}

// ─── Screenshot capture + crop ────────────────────────────────────────────────
async function captureElementShot(windowId, rect, dpr = 1) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const pad = 8;
  const sx = Math.max(0, (rect.x - pad) * dpr);
  const sy = Math.max(0, (rect.y - pad) * dpr);
  const sw = Math.min(bitmap.width - sx, (rect.width + pad * 2) * dpr);
  const sh = Math.min(bitmap.height - sy, (rect.height + pad * 2) * dpr);
  if (sw <= 0 || sh <= 0) throw new Error('element outside the visible viewport');

  // Cap the crop so payloads stay small.
  const scale = Math.min(1, 1200 / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { media_type: 'image/jpeg', data: arrayBufferToBase64(await out.arrayBuffer()) };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ─── Messages from side panel / content script ────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'elementsSelected': {
      const tabId = sender.tab?.id ?? null;
      selection = { elements: msg.elements, pageUrl: msg.pageUrl, project: msg.project || null, tabId, screenshots: [] };
      sendSelectionToBridge();
      broadcastToPanel({ action: 'selectionChanged', selection });
      // Capture element screenshots in the background, then update the panel.
      if (sender.tab) {
        captureSelectionShots(sender.tab, msg.elements, msg.dpr || 1);
      }
      break;
    }

    case 'getSelection':
      sendResponse({ selection });
      return; // sync response

    case 'clearSelection':
      selection = null;
      wsSend({ type: 'selection', elements: [], pageUrl: null });
      broadcastToPanel({ action: 'selectionChanged', selection: null });
      break;

    case 'removeSelectedElement':
      if (selection) {
        selection.elements.splice(msg.index, 1);
        selection.screenshots?.splice(msg.index, 1);
        if (!selection.elements.length) selection = null;
        sendSelectionToBridge();
        if (!selection) wsSend({ type: 'selection', elements: [], pageUrl: null });
        broadcastToPanel({ action: 'selectionChanged', selection });
      }
      break;

    case 'getBridgeStatus':
      sendResponse({ connected: wsConnected });
      return;

    case 'configUpdated':
      loadConfig().then(() => {
        try { ws?.close(); } catch { /* ignore */ }
        connectWS();
      });
      break;

    case 'injectInspector':
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) throw new Error('no active tab');
          await injectContentScript(tab.id);
          const res = await chrome.tabs.sendMessage(tab.id, { action: 'toggleInspector', multi: !!msg.multi });
          sendResponse({ ok: true, active: res?.active });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async response

    case 'reloadTabNoCache': {
      const tabId = sender.tab?.id;
      if (tabId) chrome.tabs.reload(tabId, { bypassCache: true });
      break;
    }
  }
});

async function captureSelectionShots(tab, elements, dpr) {
  const shots = [];
  for (const el of elements.slice(0, 4)) {
    try {
      shots.push(el.rect ? await captureElementShot(tab.windowId, el.rect, dpr) : null);
    } catch {
      shots.push(null);
    }
  }
  if (selection && selection.tabId === tab.id) {
    selection.screenshots = shots;
    broadcastToPanel({ action: 'selectionChanged', selection });
  }
}

// ─── UI plumbing ──────────────────────────────────────────────────────────────
function broadcastToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendBannerToTab(tabId, data) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'taskResult', data }).catch(() => {});
}

function showNotification(id, title, message, priority, requireInteraction = false) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority,
    requireInteraction,
  });
}

chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ─── Companion: browser profile snapshots over WS ─────────────────────────────
// Lets the bridge (and its MCP tools list_my_browsers / find_browser /
// focus_browser) know which Chrome profiles are connected and what tabs they
// hold. Snapshots are sent only when something actually changed; a light
// ping keeps the profile marked alive in between.

let companionProfileId = null;
let lastSnapshotKey = '';
let snapshotDebounceTimer = null;

// URLs for these hosts are redacted from snapshots (title is kept).
// Override with: chrome.storage.local.set({ sensitiveDomains: ['host', …] })
const DEFAULT_SENSITIVE_DOMAINS = [
  'accounts.google.com',
  'myaccount.google.com',
  'my.1password.com',
  'start.1password.com',
  'vault.bitwarden.com',
  'paypal.com',
  'dashboard.stripe.com',
];

async function getSensitiveDomains() {
  const saved = await chrome.storage.local.get(['sensitiveDomains']);
  return Array.isArray(saved.sensitiveDomains) ? saved.sensitiveDomains : DEFAULT_SENSITIVE_DOMAINS;
}

function isSensitiveHost(url, domains) {
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

async function getProfileId() {
  if (companionProfileId) return companionProfileId;
  const saved = await chrome.storage.local.get(['companionProfileId']);
  if (saved.companionProfileId) {
    companionProfileId = saved.companionProfileId;
  } else {
    companionProfileId = crypto.randomUUID();
    await chrome.storage.local.set({ companionProfileId });
  }
  return companionProfileId;
}

async function getProfileEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return info.email || '';
  } catch {
    return '';
  }
}

async function collectSnapshot() {
  const [profileId, email, domains, windows] = await Promise.all([
    getProfileId(),
    getProfileEmail(),
    getSensitiveDomains(),
    chrome.windows.getAll({ populate: true }),
  ]);

  const windowInfos = windows.map((w) => ({
    id: w.id,
    focused: w.focused,
    state: w.state,
    tabCount: w.tabs?.length || 0,
  }));

  const tabInfos = windows.flatMap((w) =>
    (w.tabs || []).map((t) => {
      const sensitive = isSensitiveHost(t.url || '', domains);
      return {
        id: t.id,
        windowId: w.id,
        url: sensitive ? '' : (t.url || ''),
        urlRedacted: sensitive || undefined,
        title: t.title || '',
        active: t.active,
        pinned: t.pinned,
      };
    })
  );

  return { type: 'companion_snapshot', profileId, email, windows: windowInfos, tabs: tabInfos, timestamp: Date.now() };
}

async function sendCompanionSnapshot(force = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const snapshot = await collectSnapshot();
    // Diff key: only what matters for identification (not timestamps/ids).
    const key = JSON.stringify(snapshot.tabs.map((t) => [t.url, t.title, t.active, t.windowId]))
      + '|' + snapshot.email + '|' + snapshot.windows.length;
    if (!force && key === lastSnapshotKey) {
      wsSend({ type: 'companion_ping', profileId: snapshot.profileId });
      return;
    }
    lastSnapshotKey = key;
    wsSend(snapshot);
  } catch (e) {
    console.log('[Companion] snapshot failed:', e.message);
  }
}

function debouncedSnapshot() {
  clearTimeout(snapshotDebounceTimer);
  snapshotDebounceTimer = setTimeout(() => sendCompanionSnapshot(), 500);
}

chrome.tabs.onCreated.addListener(debouncedSnapshot);
chrome.tabs.onRemoved.addListener(debouncedSnapshot);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) debouncedSnapshot();
});
chrome.windows.onCreated.addListener(debouncedSnapshot);
chrome.windows.onRemoved.addListener(debouncedSnapshot);

// Keepalive: refresh lastSeen on the bridge (sends a full snapshot only on change).
setInterval(() => sendCompanionSnapshot(), 45000);

async function handleFocusRequest() {
  const profileId = await getProfileId();
  try {
    const windows = await chrome.windows.getAll();
    const target = windows.find((w) => w.focused) || windows[0];
    if (!target) throw new Error('no windows in this profile');
    await chrome.windows.update(target.id, { focused: true, drawAttention: true });
    wsSend({ type: 'focus_ack', profileId, success: true, windowId: target.id });
  } catch (err) {
    wsSend({ type: 'focus_ack', profileId, success: false, error: err.message });
  }
}

// ─── Dev hot-reload (node dev-watch.js) ───────────────────────────────────────
async function connectDevWatch() {
  try {
    const res = await fetch('http://localhost:3132/dev-events', { headers: { 'Accept': 'text/event-stream' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (lines.some((l) => l.startsWith('event: reload'))) {
        console.log('[dev-watch] Reloading extension…');
        chrome.runtime.reload();
        return;
      }
    }
  } catch { /* dev server not running */ }
  setTimeout(connectDevWatch, 3000);
}
connectDevWatch();
