const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { diffFiles, undoFiles, normalizeFiles } = require('../lib/git-tools');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.js'), 'original\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

test('normalizeFiles keeps only paths inside the project', () => {
  const rel = normalizeFiles('/tmp/proj', ['/tmp/proj/src/a.js', '/etc/passwd', '/tmp/proj2/b.js', 'src/c.js']);
  assert.deepEqual(rel, ['src/a.js', 'src/c.js']);
});

test('diffFiles shows modified and newly created files', async () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.js'), 'brand new\n');

  const result = await diffFiles(dir, [path.join(dir, 'a.js'), path.join(dir, 'new.js')]);
  assert.equal(result.isRepo, true);
  assert.match(result.diff, /-original/);
  assert.match(result.diff, /\+changed/);
  assert.match(result.diff, /\+brand new/);
});

test('diffFiles on a non-repo reports isRepo false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-nogit-'));
  const result = await diffFiles(dir, [path.join(dir, 'x.js')]);
  assert.equal(result.isRepo, false);
});

test('undoFiles stashes modified and untracked files, restoring the worktree', async () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.js'), 'brand new\n');

  const result = await undoFiles(dir, [path.join(dir, 'a.js'), path.join(dir, 'new.js')], 'test undo');
  assert.deepEqual(result.stashed.sort(), ['a.js', 'new.js']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'original\n', 'edit was reverted');
  assert.equal(fs.existsSync(path.join(dir, 'new.js')), false, 'created file was removed');

  // The change is recoverable, not destroyed.
  const stashes = execFileSync('git', ['stash', 'list'], { cwd: dir }).toString();
  assert.match(stashes, /test undo/);
});

test('undoFiles refuses paths outside the project', async () => {
  const { dir } = makeRepo();
  await assert.rejects(() => undoFiles(dir, ['/etc/hosts'], 'x'), /no files to undo/);
});
