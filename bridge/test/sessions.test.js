const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { SessionPool, SessionStore } = require('../lib/sessions');

// Fake Agent SDK query: consumes the streaming input and answers each user
// message with a tool_use (Edit) followed by a success result.
function fakeQuery({ delayMs = 0, sessionId = 'sess-1234567890' } = {}) {
  const calls = [];
  const fn = ({ prompt, options }) => {
    calls.push({ options });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sessionId };
      for await (const userMsg of prompt) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const text = JSON.stringify(userMsg.message.content);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/a.js' } }] },
        };
        yield { type: 'result', subtype: 'success', result: `done: ${text.slice(0, 40)}`, num_turns: 1, total_cost_usd: 0.01 };
      }
    })();
  };
  fn.calls = calls;
  return fn;
}

function tmpStore() {
  return new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-')), 'sessions.json'));
}

test('runs a task and reports files, duration, turns', async () => {
  const pool = new SessionPool({ query: fakeQuery(), store: tmpStore() });
  const result = await pool.run({
    dir: '/tmp/proj',
    taskId: 't1',
    contentBlocks: [{ type: 'text', text: 'hello' }],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.files, ['/tmp/proj/a.js']);
  assert.equal(result.turns, 1);
  pool.reset();
});

test('two tasks on the same project run sequentially on one warm session', async () => {
  const q = fakeQuery({ delayMs: 30 });
  const pool = new SessionPool({ query: q, store: tmpStore() });
  const order = [];
  const p1 = pool.run({ dir: '/tmp/proj', taskId: 'a', contentBlocks: [{ type: 'text', text: '1' }] })
    .then(() => order.push('a'));
  const p2 = pool.run({ dir: '/tmp/proj', taskId: 'b', contentBlocks: [{ type: 'text', text: '2' }] })
    .then(() => order.push('b'));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a', 'b'], 'queued in order');
  assert.equal(q.calls.length, 1, 'a single warm SDK process served both tasks');
  pool.reset();
});

test('session id is persisted per (project, mode)', async () => {
  const store = tmpStore();
  const pool = new SessionPool({ query: fakeQuery({ sessionId: 'sess-abc' }), store });
  await pool.run({ dir: '/tmp/proj', taskId: 't', contentBlocks: [{ type: 'text', text: 'x' }] });
  assert.equal(store.get('/tmp/proj', 'edit'), 'sess-abc');
  assert.equal(store.get('/tmp/proj', 'explain'), null);
  pool.reset();
});

test('explain mode restricts tools to read-only', async () => {
  const q = fakeQuery();
  const pool = new SessionPool({ query: q, store: tmpStore() });
  await pool.run({ dir: '/tmp/proj', mode: 'explain', taskId: 't', contentBlocks: [{ type: 'text', text: 'x' }] });
  const options = q.calls[0].options;
  assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep']);
  assert.ok(!options.allowedTools.includes('Bash'));
  pool.reset();
});

test('different modes use different sessions', async () => {
  const q = fakeQuery();
  const pool = new SessionPool({ query: q, store: tmpStore() });
  await pool.run({ dir: '/tmp/proj', mode: 'edit', taskId: 't1', contentBlocks: [{ type: 'text', text: 'x' }] });
  await pool.run({ dir: '/tmp/proj', mode: 'explain', taskId: 't2', contentBlocks: [{ type: 'text', text: 'y' }] });
  assert.equal(q.calls.length, 2);
  pool.reset();
});
