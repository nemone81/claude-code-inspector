// Claude Code Inspector - Background Service Worker
// Includes a keepalive alarm to prevent the service worker from going idle

let selectedElementInfo = null;
let bridgeUrl = 'http://localhost:3131';
let isConnected = false;
let reconnectTimer = null;

// ─── Keep the service worker alive ────────────────────────────────────────────
// Service workers go idle after ~30s of inactivity.
// This alarm wakes them up periodically.
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // every 24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Touching storage is enough to wake the worker
    chrome.storage.local.get('_ka');
  }
});

// ─── Messages from popup / content script ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'elementSelected') {
    selectedElementInfo = msg.info;
    const windowId = sender.tab?.windowId;
    chrome.action.openPopup(windowId ? { windowId } : undefined).catch(() => {});
  }
  if (msg.action === 'getSelectedElement') sendResponse({ info: selectedElementInfo });
  if (msg.action === 'clearSelectedElement') selectedElementInfo = null;
  if (msg.action === 'getBridgeStatus')   sendResponse({ connected: isConnected, bridgeUrl });
  if (msg.action === 'updateBridgeUrl') { bridgeUrl = msg.url; reconnectSSE(); }
  if (msg.action === 'reloadTabNoCache') {
    const tabId = sender.tab?.id;
    if (tabId) chrome.tabs.reload(tabId, { bypassCache: true });
  }
});

// ─── SSE connection ───────────────────────────────────────────────────────────
let abortController = null;

async function connectSSE() {
  if (abortController) return; // already running

  abortController = new AbortController();

  try {
    const response = await fetch(`${bridgeUrl}/events`, {
      headers: { 'Accept': 'text/event-stream' },
      signal: abortController.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    isConnected = true;
    console.log('[SSE] Connected');
    broadcastStatus(true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = 'message';
    let eventData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        } else if (line === '') {
          if (eventData) {
            handleSseEvent(eventName, eventData);
            eventName = 'message';
            eventData = '';
          }
        }
      }
    }

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.log('[SSE] Disconnected:', err.message);
    }
  }

  abortController = null;
  isConnected = false;
  broadcastStatus(false);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE();
  }, 3000);
}

function reconnectSSE() {
  if (abortController) { abortController.abort(); abortController = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  isConnected = false;
  connectSSE();
}

function broadcastStatus(connected) {
  chrome.runtime.sendMessage({ action: 'sseStatus', connected }).catch(() => {});
}

// ─── SSE event handling ───────────────────────────────────────────────────────
function handleSseEvent(eventName, dataStr) {
  let data;
  try { data = JSON.parse(dataStr); } catch { return; }

  switch (eventName) {
    case 'task_start':
      showNotification(data.taskId, '⏳ Claude is working…', truncate(data.prompt, 80), 0);
      chrome.action.setBadgeText({ text: '…' });
      chrome.action.setBadgeBackgroundColor({ color: '#CC785C' });
      break;

    case 'task_progress':
      chrome.notifications.update(data.taskId, {
        message: `⚙ ${data.tool}${data.detail ? ': ' + truncate(data.detail, 50) : ''}`
      });
      break;

    case 'task_done':
      chrome.action.setBadgeText({ text: '' });
      chrome.notifications.clear(data.taskId);

      if (data.success) {
        const filesInfo = data.filesModified > 0 ? ` · ${data.filesModified} files modified` : '';
        showNotification(
          data.taskId + '_done',
          '✓ Claude completed the task',
          truncate(data.result || 'Changes applied', 120) + `\n\n⏱ ${data.durationSec}s${filesInfo}`,
          2,
          true
        );
      } else {
        showNotification(data.taskId + '_err', '✗ Task failed', truncate(data.error || 'Unknown error', 150), 2, true);
      }

      // Send a persistent banner to the active tab
      sendTaskResultToActiveTab(data);
      break;

    case 'session_reset':
      chrome.action.setBadgeText({ text: '' });
      break;
  }

  chrome.runtime.sendMessage({ action: 'sseEvent', eventName, data }).catch(() => {});
}

// ─── Chrome notifications ─────────────────────────────────────────────────────
function showNotification(id, title, message, priority, requireInteraction = false) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority,
    requireInteraction
  });
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.action.openPopup?.();
});

// ─── In-page banner ───────────────────────────────────────────────────────────
function sendTaskResultToActiveTab(data) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { action: 'taskResult', data }).catch(() => {});
  });
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ─── Dev hot-reload (node dev-watch.js) ───────────────────────────────────────
async function connectDevWatch() {
  try {
    const ctrl = new AbortController();
    const res  = await fetch('http://localhost:3132/dev-events', {
      headers: { 'Accept': 'text/event-stream' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event: reload')) {
          console.log('[dev-watch] Reloading extension…');
          chrome.runtime.reload();
          return;
        }
      }
    }
  } catch {
    // dev server not running, ignore
  }
  setTimeout(connectDevWatch, 3000);
}
connectDevWatch();

// ─── Bootstrap ────────────────────────────────────────────────────────────────
chrome.storage.local.get(['config'], (result) => {
  if (result.config?.bridgeUrl) bridgeUrl = result.config.bridgeUrl;
  connectSSE();
});

chrome.runtime.onStartup.addListener(() => connectSSE());
chrome.runtime.onInstalled.addListener(() => connectSSE());
