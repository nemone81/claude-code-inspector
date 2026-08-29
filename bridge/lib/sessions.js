// Warm Agent SDK sessions, one per (projectPath, mode), with a task queue.
//
// Instead of a cold SDK spawn per task, each project keeps a long-lived
// query in streaming-input mode: new prompts are pushed into the same
// process, which also preserves conversation context. Sessions are
// persisted so a bridge restart resumes where it left off.

const fs = require('fs');
const path = require('path');
const { createPushable } = require('./pushable');

const SESSIONS_FILE = path.join(__dirname, '..', '.sessions.json');
const IDLE_DISPOSE_MS = 15 * 60 * 1000; // shut a warm process down after 15 min idle
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

const MODES = {
  edit: {
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    permissionMode: 'acceptEdits',
  },
  explain: {
    allowedTools: ['Read', 'Glob', 'Grep'],
    permissionMode: 'default',
  },
};

class SessionStore {
  constructor(file = SESSIONS_FILE) {
    this.file = file;
    this.map = {};
    try {
      this.map = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* first run */ }
  }
  key(dir, mode) { return `${dir}::${mode}`; }
  get(dir, mode) { return this.map[this.key(dir, mode)] || null; }
  set(dir, mode, sessionId) {
    this.map[this.key(dir, mode)] = sessionId;
    this._save();
  }
  clear(dir, mode) {
    if (dir) delete this.map[this.key(dir, mode)];
    else this.map = {};
    this._save();
  }
  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2)); } catch { /* non-fatal */ }
  }
}

class ProjectSession {
  constructor({ dir, mode, query, claudePath, resumeId, onSessionId, onDispose }) {
    this.dir = dir;
    this.mode = mode;
    this.queryFn = query;
    this.claudePath = claudePath;
    this.resumeId = resumeId || null;
    this.onSessionId = onSessionId;
    this.onDispose = onDispose;

    this.sessionId = null;
    this.current = null;      // { resolve, reject, taskId, onProgress, toolsUsed, files, startedAt, timer }
    this.chain = Promise.resolve();
    this.disposed = false;
    this.idleTimer = null;

    this._start();
  }

  _start() {
    const modeCfg = MODES[this.mode] || MODES.edit;
    const options = {
      cwd: this.dir,
      permissionMode: modeCfg.permissionMode,
      allowedTools: modeCfg.allowedTools,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
    };
    if (this.claudePath) options.pathToClaudeCodeExecutable = this.claudePath;
    if (this.resumeId) options.resume = this.resumeId;

    this.input = createPushable();
    this.q = this.queryFn({ prompt: this.input, options });
    this.reader = this._readLoop().catch((err) => this._fail(err));
  }

  async _readLoop() {
    for await (const msg of this.q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        this.sessionId = msg.session_id;
        this.onSessionId?.(msg.session_id);
      }

      if (msg.type === 'assistant' && msg.message?.content && this.current) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const input = block.input || {};
            const detail = input.file_path || (input.command ? String(input.command).slice(0, 60) : '');
            this.current.toolsUsed.push(block.name);
            if (['Write', 'Edit'].includes(block.name) && input.file_path) {
              this.current.files.add(input.file_path);
            }
            this.current.onProgress?.({ tool: block.name, detail });
          }
        }
      }

      if (msg.type === 'result' && this.current) {
        const task = this.current;
        this.current = null;
        clearTimeout(task.timer);
        if (msg.subtype === 'success') {
          task.resolve({
            success: true,
            output: msg.result || '',
            durationSec: ((Date.now() - task.startedAt) / 1000).toFixed(1),
            turns: msg.num_turns,
            costUsd: msg.total_cost_usd,
            files: [...task.files],
            toolsUsed: task.toolsUsed,
          });
        } else {
          task.reject(new Error(msg.errors?.join(', ') || msg.subtype || 'unknown error'));
        }
        this._touchIdle();
      }
    }
    // The underlying process ended.
    this._fail(new Error('Claude session ended unexpectedly'));
  }

  _fail(err) {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(err);
      this.current = null;
    }
    try { this.input.end(); } catch { /* already closed */ }
    this.onDispose?.(this, err);
  }

  _touchIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_DISPOSE_MS);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    try { this.input.end(); } catch { /* already closed */ }
    this.onDispose?.(this, null);
  }

  // Queue a task. contentBlocks is an array of Anthropic content blocks.
  run({ taskId, contentBlocks, onProgress }) {
    if (this.disposed) return Promise.reject(new Error('session disposed'));
    clearTimeout(this.idleTimer);

    const job = () => new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('session disposed')); return; }
      this.current = {
        taskId,
        resolve,
        reject,
        onProgress,
        toolsUsed: [],
        files: new Set(),
        startedAt: Date.now(),
        timer: setTimeout(() => {
          reject(new Error('task timed out'));
          this.current = null;
        }, TASK_TIMEOUT_MS),
      };
      this.input.push({
        type: 'user',
        message: { role: 'user', content: contentBlocks },
      });
    });

    const result = this.chain.then(job, job);
    this.chain = result.catch(() => {});
    return result;
  }
}

class SessionPool {
  constructor({ query, claudePath, store }) {
    this.queryFn = query;
    this.claudePath = claudePath;
    this.store = store || new SessionStore();
    this.sessions = new Map(); // key → ProjectSession
  }

  key(dir, mode) { return `${dir}::${mode}`; }

  _get(dir, mode) {
    const key = this.key(dir, mode);
    let session = this.sessions.get(key);
    if (session && !session.disposed) return session;

    session = new ProjectSession({
      dir,
      mode,
      query: this.queryFn,
      claudePath: this.claudePath,
      resumeId: this.store.get(dir, mode),
      onSessionId: (id) => this.store.set(dir, mode, id),
      onDispose: (s) => {
        if (this.sessions.get(key) === s) this.sessions.delete(key);
      },
    });
    this.sessions.set(key, session);
    return session;
  }

  async run({ dir, mode = 'edit', taskId, contentBlocks, onProgress }) {
    try {
      return await this._get(dir, mode).run({ taskId, contentBlocks, onProgress });
    } catch (err) {
      // A stale resume id makes the process die on start: clear it and retry once fresh.
      const m = String(err.message || '');
      if (/session|resume|unexpectedly/i.test(m) && this.store.get(dir, mode)) {
        this.store.clear(dir, mode);
        this.sessions.get(this.key(dir, mode))?.dispose();
        return this._get(dir, mode).run({ taskId, contentBlocks, onProgress });
      }
      throw err;
    }
  }

  reset(dir, mode) {
    if (dir) {
      for (const m of mode ? [mode] : Object.keys(MODES)) {
        this.sessions.get(this.key(dir, m))?.dispose();
        this.store.clear(dir, m);
      }
    } else {
      for (const s of this.sessions.values()) s.dispose();
      this.sessions.clear();
      this.store.clear();
    }
  }

  status() {
    return [...this.sessions.entries()].map(([key, s]) => ({
      key,
      sessionId: s.sessionId ? s.sessionId.slice(0, 8) + '…' : null,
      busy: !!s.current,
    }));
  }
}

module.exports = { SessionPool, SessionStore, ProjectSession, MODES, SESSIONS_FILE };
