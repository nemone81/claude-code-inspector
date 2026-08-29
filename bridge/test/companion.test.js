const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { CompanionStore, sampleTabs } = require('../lib/companion');

function tmpAliasFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-test-'));
  const file = path.join(dir, 'aliases.json');
  if (content) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

function snapshot(tabs, email = 'me@test.local') {
  return { email, windows: [{ id: 1, focused: true, state: 'normal', tabCount: tabs.length }], tabs };
}

test('upsert + list expose alias, email, counts and sample tabs', () => {
  const store = new CompanionStore({ aliasFile: tmpAliasFile({ p1: 'work' }) });
  store.upsert('p1', snapshot([
    { title: 'GitHub', url: 'https://github.com', active: false, windowId: 1 },
    { title: 'Docs', url: 'https://docs.test', active: true, windowId: 1 },
  ]));
  const [b] = store.list();
  assert.equal(b.id, 'p1');
  assert.equal(b.alias, 'work');
  assert.equal(b.email, 'me@test.local');
  assert.equal(b.tabCount, 2);
  assert.equal(b.sampleTabs[0].title, 'Docs', 'active tab is listed first');
});

test('find matches url and title case-insensitively', () => {
  const store = new CompanionStore({ aliasFile: tmpAliasFile() });
  store.upsert('p1', snapshot([{ title: 'My GitHub PR', url: 'https://github.com/x', active: true, windowId: 1 }]));
  store.upsert('p2', snapshot([{ title: 'News', url: 'https://news.test', active: true, windowId: 2 }]));

  const byTitle = store.find('github pr');
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].id, 'p1');
  assert.equal(store.find('news.test').length, 1);
  assert.equal(store.find('nomatch').length, 0);
});

test('stale profiles are pruned; touch keeps them alive', () => {
  const store = new CompanionStore({ aliasFile: tmpAliasFile(), staleTimeoutMs: 50 });
  store.upsert('p1', snapshot([]));
  store.upsert('p2', snapshot([]));
  return new Promise((resolve) => {
    setTimeout(() => {
      store.touch('p2');
      setTimeout(() => {
        const ids = store.list().map((b) => b.id);
        assert.deepEqual(ids, ['p2'], 'p1 pruned, touched p2 survives');
        resolve();
      }, 40);
    }, 40);
  });
});

test('focus round-trip resolves with the ack', async () => {
  const store = new CompanionStore({ aliasFile: tmpAliasFile() });
  const pending = store.awaitFocus('p1');
  const handled = store.resolveFocus('p1', { success: true, windowId: 7 });
  assert.equal(handled, true);
  assert.deepEqual(await pending, { success: true, windowId: 7 });
  assert.equal(store.resolveFocus('p1', {}), false, 'second resolve is a no-op');
});

test('focus times out when no ack arrives', async () => {
  const store = new CompanionStore({ aliasFile: tmpAliasFile() });
  const result = await store.awaitFocus('p1', 30);
  assert.equal(result.success, false);
  assert.match(result.error, /Timeout/);
});

test('sampleTabs caps the list and prioritizes active tabs', () => {
  const tabs = [
    { title: 't1', url: 'u1', active: false },
    { title: 't2', url: 'u2', active: true },
    { title: 't3', url: 'u3', active: false },
  ];
  const sample = sampleTabs(tabs, 2);
  assert.equal(sample.length, 2);
  assert.equal(sample[0].title, 't2');
});
