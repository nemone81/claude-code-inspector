// Git helpers for diff preview and task undo. Uses execFile (no shell) so
// file paths can never be interpreted as shell syntax.

const { execFile } = require('child_process');
const path = require('path');

function git(dir, args, { allowExit1 = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !(allowExit1 && err.code === 1)) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

async function isRepo(dir) {
  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

// Keep only files inside the project dir (defense against odd paths coming
// back from tool_use inputs) and make them repo-relative.
function normalizeFiles(dir, files) {
  const root = path.resolve(dir);
  return files
    .map((f) => path.resolve(root, f))
    .filter((f) => f === root || f.startsWith(root + path.sep))
    .map((f) => path.relative(root, f))
    .filter(Boolean);
}

// Diff of the given files (worktree vs HEAD), plus their status.
async function diffFiles(dir, files) {
  if (!(await isRepo(dir))) return { isRepo: false, diff: '', status: '' };
  const rel = normalizeFiles(dir, files);
  if (!rel.length) return { isRepo: true, diff: '', status: '' };
  const status = await git(dir, ['status', '--short', '--', ...rel]).catch(() => '');
  let diff = await git(dir, ['diff', 'HEAD', '--', ...rel]).catch(() => '');
  // New untracked files don't show in `git diff HEAD`; diff them against /dev/null
  // (exits 1 when the files differ, which is the normal case here).
  const untracked = status.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
  for (const f of untracked) {
    const content = await git(dir, ['diff', '--no-index', '--', '/dev/null', f], { allowExit1: true })
      .catch(() => `+++ new file: ${f}\n`);
    diff += (diff ? '\n' : '') + content;
  }
  return { isRepo: true, diff: diff.slice(0, 200 * 1024), status };
}

// Undo the last task by stashing its files (recoverable via `git stash pop`).
// `-u` includes files the task newly created.
async function undoFiles(dir, files, label) {
  if (!(await isRepo(dir))) throw new Error('not a git repository');
  const rel = normalizeFiles(dir, files);
  if (!rel.length) throw new Error('no files to undo');
  await git(dir, ['stash', 'push', '--include-untracked', '-m', label || 'claude-inspector undo', '--', ...rel]);
  return { stashed: rel };
}

module.exports = { diffFiles, undoFiles, normalizeFiles, isRepo, git };
