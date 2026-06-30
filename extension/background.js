// Claude Code Inspector + Chrome Companion - Background Service Worker v4
// SSE per task inspector + HTTP polling per companion snapshot/focus

let selectedElementInfo = null;
let bridgeUrl = 'http://localhost:3131';
let isConnected = false;
let reconnectTimer = null;

// ─── Mantieni il service worker sveglio ──────────────────────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // ogni 24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    chrome.storage.local.get('_ka');
  }
  if (alarm.name === 'companionPoll') {
    collectAndSendSnapshot();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INSPECTOR — SSE Connection (invariato)
// ═══════════════════════════════════════════════════════════════════════════════

let abortController = null;

async function connectSSE() {
  if (abortController) return;

  abortController = new AbortController();

  try {
    const response = await fetch(`${bridgeUrl}/events`, {
      headers: { 'Accept': 'text/event-stream' },
      signal: abortController.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    isConnected = true;
    console.log('[SSE] Connesso');
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
      console.log('[SSE] Disconnesso:', err.message);
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

// ─── Gestione eventi SSE ──────────────────────────────────────────────────────
function handleSseEvent(eventName, dataStr) {
  let data;
  try { data = JSON.parse(dataStr); } catch { return; }

  switch (eventName) {
    case 'task_start':
      showNotification(data.taskId, '⏳ Claude sta lavorando…', truncate(data.prompt, 80), 0);
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
        const filesInfo = data.filesModified > 0 ? ` · ${data.filesModified} file modificati` : '';
        showNotification(
          data.taskId + '_done',
          '✓ Claude ha completato il task',
          truncate(data.result || 'Modifiche applicate', 120) + `\n\n⏱ ${data.durationSec}s${filesInfo}`,
          2,
          true
        );
      } else {
        showNotification(data.taskId + '_err', '✗ Errore nel task', truncate(data.error || 'Errore sconosciuto', 150), 2, true);
      }

      sendTaskResultToActiveTab(data);
      break;

    case 'session_reset':
      chrome.action.setBadgeText({ text: '' });
      break;
  }

  chrome.runtime.sendMessage({ action: 'sseEvent', eventName, data }).catch(() => {});
}

// ─── Chrome Notifications ─────────────────────────────────────────────────────
function showNotification(id, title, message, priority, requireInteraction = false) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icon128.png',
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

// ─── Banner in-page + reload senza cache ──────────────────────────────────────
function sendTaskResultToActiveTab(data) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { action: 'taskResult', data }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === 'reloadTabNoCache') {
    const tabId = sender.tab?.id;
    if (tabId) chrome.tabs.reload(tabId, { bypassCache: true });
  }
});

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANION — Profile ID, HTTP Polling, Snapshot, Focus
// ═══════════════════════════════════════════════════════════════════════════════

let companionProfileId = null;
let companionEmail = '';
let companionConnected = false;
let snapshotDebounceTimer = null;

// ─── Profile ID stabile ───────────────────────────────────────────────────────
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function initProfileId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['companionProfileId'], (result) => {
      if (result.companionProfileId) {
        companionProfileId = result.companionProfileId;
      } else {
        companionProfileId = generateUUID();
        chrome.storage.local.set({ companionProfileId });
      }
      console.log(`[Companion] ProfileId: ${companionProfileId.slice(0, 8)}…`);
      resolve();
    });
  });
}

async function loadProfileEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    companionEmail = info.email || '';
  } catch {
    companionEmail = '';
  }
}

// ─── HTTP Polling — Snapshot + Command reception ──────────────────────────────
async function collectAndSendSnapshot() {
  if (!companionProfileId) return;

  await loadProfileEmail();

  let windowInfos, tabInfos;
  try {
    const windows = await chrome.windows.getAll({ populate: true });

    windowInfos = windows.map(w => ({
      id: w.id,
      focused: w.focused,
      state: w.state,
      tabCount: w.tabs?.length || 0,
    }));

    tabInfos = windows.flatMap(w =>
      (w.tabs || []).map(t => ({
        id: t.id,
        windowId: w.id,
        url: t.url || '',
        title: t.title || '',
        active: t.active,
        pinned: t.pinned,
      }))
    );
  } catch (err) {
    console.log('[Companion] Errore lettura tab:', err.message);
    return;
  }

  const snapshot = {
    profileId: companionProfileId,
    email: companionEmail,
    windows: windowInfos,
    tabs: tabInfos,
    timestamp: Date.now(),
  };

  try {
    const res = await fetch(`${bridgeUrl}/companion/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      if (!companionConnected) {
        companionConnected = true;
        console.log('[Companion] Connesso al bridge');
        chrome.runtime.sendMessage({ action: 'companionStatus', connected: true }).catch(() => {});
      }

      if (data.command?.type === 'focus') {
        handleFocusCommand(data.command.windowId);
      }
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    if (companionConnected) {
      companionConnected = false;
      console.log('[Companion] Bridge non raggiungibile');
      chrome.runtime.sendMessage({ action: 'companionStatus', connected: false }).catch(() => {});
    }
  }
}

function debouncedSnapshot() {
  if (snapshotDebounceTimer) clearTimeout(snapshotDebounceTimer);
  snapshotDebounceTimer = setTimeout(() => {
    snapshotDebounceTimer = null;
    collectAndSendSnapshot();
  }, 500);
}

// ─── Focus Handler ────────────────────────────────────────────────────────────
async function handleFocusCommand(windowId) {
  try {
    let targetId;
    if (windowId) {
      targetId = windowId;
    } else {
      const windows = await chrome.windows.getAll();
      const target = windows.find(w => w.focused) || windows[0];
      targetId = target?.id;
    }

    if (targetId) {
      await chrome.windows.update(targetId, { focused: true });
      await fetch(`${bridgeUrl}/companion/focus_ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: companionProfileId, success: true, windowId: targetId }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
  } catch (err) {
    console.log('[Companion] Errore focus:', err.message);
    await fetch(`${bridgeUrl}/companion/focus_ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: companionProfileId, success: false }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}

// ─── Tab/Window Event Listeners ───────────────────────────────────────────────
chrome.tabs.onCreated.addListener(debouncedSnapshot);
chrome.tabs.onRemoved.addListener(debouncedSnapshot);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) debouncedSnapshot();
});
chrome.windows.onCreated.addListener(debouncedSnapshot);
chrome.windows.onRemoved.addListener(debouncedSnapshot);

// Polling periodico ogni 30s via chrome.alarms (minimo consentito da Chrome)
chrome.alarms.create('companionPoll', { periodInMinutes: 0.5 });

// ─── Messaggi dal popup / content script ─────────────────────────────────────
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

  if (msg.action === 'getProfileInfo') {
    sendResponse({
      profileId: companionProfileId,
      email: companionEmail,
      wsConnected: companionConnected,
    });
  }
});

// ─── Dev hot-reload (node dev-watch.js) ──────────────────────────────────────
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
          console.log('[dev-watch] Ricarico estensione…');
          chrome.runtime.reload();
          return;
        }
      }
    }
  } catch {
    // dev server non attivo, ok
  }
  setTimeout(connectDevWatch, 3000);
}
connectDevWatch();

// ─── Avvio ────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['config'], async (result) => {
  if (result.config?.bridgeUrl) bridgeUrl = result.config.bridgeUrl;
  connectSSE();

  await initProfileId();
  await loadProfileEmail();
  collectAndSendSnapshot();
});

chrome.runtime.onStartup.addListener(async () => {
  connectSSE();
  await initProfileId();
  await loadProfileEmail();
  collectAndSendSnapshot();
});

chrome.runtime.onInstalled.addListener(async () => {
  connectSSE();
  await initProfileId();
  await loadProfileEmail();
  collectAndSendSnapshot();
});
