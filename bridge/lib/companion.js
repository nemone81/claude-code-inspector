// Chrome Companion store: tracks connected Chrome profiles (email, windows,
// tabs) from snapshots the extension pushes over the WebSocket, plus
// human-readable aliases and pending focus commands.
//
// Aliases live in ~/.chrome-companion/aliases.json ({ profileId: "name" })
// and are hot-reloaded on change.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALIAS_DIR = path.join(os.homedir(), '.chrome-companion');
const ALIAS_FILE = path.join(ALIAS_DIR, 'aliases.json');
const STALE_TIMEOUT_MS = 120_000;
const FOCUS_TIMEOUT_MS = 45_000;

class CompanionStore {
  constructor({ aliasFile = ALIAS_FILE, staleTimeoutMs = STALE_TIMEOUT_MS } = {}) {
    this.aliasFile = aliasFile;
    this.staleTimeoutMs = staleTimeoutMs;
    this.browsers = new Map();       // profileId → { snapshot, lastSeen }
    this.pendingFocus = new Map();   // profileId → { resolve, timer }
    this.aliases = {};
    this._initAliases();
  }

  _initAliases() {
    try {
      fs.mkdirSync(path.dirname(this.aliasFile), { recursive: true });
      if (!fs.existsSync(this.aliasFile)) fs.writeFileSync(this.aliasFile, '{}', 'utf8');
    } catch { /* non-fatal */ }
    this._loadAliases();
    try {
      fs.watch(this.aliasFile, { persistent: false }, () => this._loadAliases());
    } catch { /* non-fatal */ }
  }

  _loadAliases() {
    try {
      this.aliases = JSON.parse(fs.readFileSync(this.aliasFile, 'utf8'));
    } catch {
      this.aliases = {};
    }
  }

  alias(profileId) {
    return this.aliases[profileId] || null;
  }

  upsert(profileId, snapshot) {
    this.browsers.set(profileId, { snapshot, lastSeen: Date.now() });
  }

  // Lightweight keepalive: refresh lastSeen without a new snapshot.
  touch(profileId) {
    const entry = this.browsers.get(profileId);
    if (entry) entry.lastSeen = Date.now();
  }

  remove(profileId) {
    this.browsers.delete(profileId);
  }

  prune() {
    const now = Date.now();
    for (const [id, entry] of this.browsers) {
      if (now - entry.lastSeen > this.staleTimeoutMs) this.browsers.delete(id);
    }
  }

  list() {
    this.prune();
    return [...this.browsers.entries()].map(([id, entry]) => ({
      id,
      alias: this.alias(id),
      email: entry.snapshot.email || '',
      windowCount: entry.snapshot.windows?.length || 0,
      tabCount: entry.snapshot.tabs?.length || 0,
      sampleTabs: sampleTabs(entry.snapshot.tabs, 5),
      lastSeen: new Date(entry.lastSeen).toISOString(),
    }));
  }

  find(q) {
    this.prune();
    const ql = String(q).toLowerCase();
    const matches = [];
    for (const [id, entry] of this.browsers) {
      const matched = (entry.snapshot.tabs || []).filter((t) =>
        (t.url && t.url.toLowerCase().includes(ql)) ||
        (t.title && t.title.toLowerCase().includes(ql))
      );
      if (matched.length) {
        matches.push({
          id,
          alias: this.alias(id),
          email: entry.snapshot.email || '',
          matchedTabs: matched.map((t) => ({ title: t.title, url: t.url, windowId: t.windowId })),
        });
      }
    }
    return matches;
  }

  has(profileId) {
    this.prune();
    return this.browsers.has(profileId);
  }

  // Focus round-trip: awaitFocus() resolves when resolveFocus() is called
  // with the extension's ack, or with a timeout error.
  awaitFocus(profileId, timeoutMs = FOCUS_TIMEOUT_MS) {
    // A newer request supersedes a pending one for the same profile.
    this.resolveFocus(profileId, { success: false, error: 'superseded by a newer focus request' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFocus.delete(profileId);
        resolve({ success: false, error: `Timeout: the extension did not respond within ${timeoutMs / 1000}s` });
      }, timeoutMs);
      this.pendingFocus.set(profileId, { resolve, timer });
    });
  }

  resolveFocus(profileId, result) {
    const entry = this.pendingFocus.get(profileId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingFocus.delete(profileId);
    entry.resolve(result);
    return true;
  }
}

function sampleTabs(tabs, max) {
  if (!tabs || !tabs.length) return [];
  const active = tabs.filter((t) => t.active);
  const rest = tabs.filter((t) => !t.active);
  return [...active, ...rest].slice(0, max).map((t) => ({ title: t.title, url: t.url }));
}

module.exports = { CompanionStore, sampleTabs, ALIAS_FILE, STALE_TIMEOUT_MS };
