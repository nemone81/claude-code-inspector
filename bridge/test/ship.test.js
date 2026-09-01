const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  readShipConfig,
  writeShipConfig,
  detectProject,
  fallbackMessage,
  ship,
  CONFIG_FILE,
} = require('../lib/ship');

// Un repo vero e usa e getta: il valore di questi test sta nel fatto che git
// e' git, non un finto oggetto che si comporta come speriamo.
function tempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-ship-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  // Un primo commit ci vuole sempre: senza, `git commit` fallisce e il test
  // si romperebbe per una ragione che non ha niente a che vedere con lo ship.
  fs.writeFileSync(path.join(dir, '.keep'), '');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return { dir, git };
}

const show = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

test('config: si legge quello che il progetto dichiara, con i vuoti al posto giusto', () => {
  const { dir } = tempRepo();
  assert.equal(readShipConfig(dir), null, 'senza file non si inventa una configurazione');

  writeShipConfig(dir, { checks: ['echo ok'], ship: { push: false } });
  const cfg = readShipConfig(dir);
  assert.deepEqual(cfg.checks, ['echo ok']);
  assert.equal(cfg.ship.push, false);
  assert.equal(cfg.ship.remote, 'origin', 'il remote ha un default');
  assert.equal(cfg.deploy.run, null, 'nessun deploy dichiarato = nessun comando');
  assert.ok(fs.existsSync(path.join(dir, CONFIG_FILE)));
});

test('config: quello che non e\' una stringa non diventa un comando', () => {
  // Il file sta nel repo e lo scrive una persona: un valore storto dev'essere
  // ignorato, non eseguito.
  const { dir } = tempRepo();
  writeShipConfig(dir, { checks: ['ok', 42, null], deploy: { run: { evil: true } } });
  const cfg = readShipConfig(dir);
  assert.deepEqual(cfg.checks, ['ok']);
  assert.equal(cfg.deploy.run, null);
});

/**
 * Quali comandi esistono, per questo test.
 *
 * Senza, il risultato dipenderebbe da cosa e' installato sulla macchina che
 * esegue la suite: verde qui, rosso su un altro Mac, e nessuna delle due cose
 * direbbe niente sul codice.
 */
function withPath(bins, fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-bin-'));
  for (const b of bins) {
    fs.writeFileSync(path.join(binDir, b), '#!/bin/sh\n', { mode: 0o755 });
  }
  const before = process.env.PATH;
  process.env.PATH = binDir;
  try { return fn(); } finally { process.env.PATH = before; }
}

test('detect: propone guardando il repo, e dice cosa ha visto', () => {
  const { dir } = tempRepo({
    'package.json': JSON.stringify({ scripts: { lint: 'x', test: 'y' } }),
    'pnpm-lock.yaml': '',
    '.vercel/project.json': '{}',
  });
  const { seen, suggestion } = withPath(['pnpm'], () => detectProject(dir));

  assert.deepEqual(suggestion.checks, ['pnpm lint', 'pnpm test'], 'usa il gestore di pacchetti del repo');
  assert.ok(seen.some((s) => s.includes('.vercel/project.json')), 'la prova si mostra a chi conferma');
  assert.equal(suggestion.deploy.run, null, 'dove il deploy parte dal push non si lancia niente');
  assert.ok(suggestion.deploy.status, 'ma si sa come chiedere com\'e\' andata');
});

test('detect: senza indizi non propone comandi', () => {
  const { dir } = tempRepo();
  const { suggestion } = withPath([], () => detectProject(dir));
  assert.deepEqual(suggestion.checks, []);
  assert.equal(suggestion.deploy, undefined);
});

// Il caso vero: un bun.lockb lasciato da uno scaffold vive nel repo di chi bun
// non ce l'ha, e proporlo fa fallire la prima Ship con exit 127.
test('detect: un lockfile di un gestore non installato non decide i comandi', () => {
  const files = { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) };
  for (const lock of ['bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock']) {
    const { dir } = tempRepo({ ...files, [lock]: '' });
    const { suggestion } = withPath(['npm'], () => detectProject(dir));
    assert.deepEqual(suggestion.checks, ['npm run test'], `${lock} senza il suo comando ricade su npm`);
  }
});

test('detect: bun.lock vale quanto bun.lockb quando bun c\'e\'', () => {
  for (const lock of ['bun.lockb', 'bun.lock']) {
    const { dir } = tempRepo({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }), [lock]: '' });
    const { suggestion } = withPath(['bun'], () => detectProject(dir));
    assert.deepEqual(suggestion.checks, ['bun run test'], lock);
  }
});

// Uno script di deploy nella radice e' lo stesso script che sta in deploy/:
// non vederlo significa proporre una Ship che committa, spinge e non pubblica.
test('detect: lo script di deploy si cerca anche nella radice', () => {
  for (const script of ['deploy.sh', 'deploy/deploy.sh', 'scripts/deploy.sh']) {
    const { dir } = tempRepo({ [script]: '#!/bin/sh\n' });
    const { seen, suggestion } = withPath(['npm'], () => detectProject(dir));
    assert.equal(suggestion.deploy.run, `./${script}`, script);
    assert.ok(seen.includes(script), `chi conferma vede da dove viene: ${script}`);
  }
});

test('detect: uno script "deploy" nel package.json ha la precedenza sul file', () => {
  const { dir } = tempRepo({
    'package.json': JSON.stringify({ scripts: { deploy: 'x' } }),
    'deploy.sh': '#!/bin/sh\n',
  });
  const { suggestion } = withPath(['npm'], () => detectProject(dir));
  assert.equal(suggestion.deploy.run, 'npm run deploy');
});

test('ship: committa **solo** i file del task', async () => {
  // ⚠️ E' la regola che rende il bottone usabile: nel repo c'e' quasi sempre
  // altro lavoro aperto, e pubblicarlo di straforo perche' era li' nello
  // stesso momento e' il modo piu' rapido per non fidarsi piu'.
  const { dir } = tempRepo({ 'a.txt': 'uno\n', 'b.txt': 'due\n' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno modificato\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'lavoro in corso di qualcun altro\n');

  const result = await ship({
    dir,
    files: ['a.txt'],
    message: 'tocca solo a.txt',
    config: { checks: [], ship: { push: false }, deploy: {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(show(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.txt']);
  assert.match(show(dir, 'status', '--short'), /b\.txt/, 'il resto resta non committato');
});

test('ship: un controllo che fallisce ferma tutto prima del commit', async () => {
  const { dir } = tempRepo({ 'a.txt': 'uno\n' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'due\n');
  const before = show(dir, 'rev-parse', 'HEAD');

  const result = await ship({
    dir,
    files: ['a.txt'],
    message: 'non deve arrivare',
    config: { checks: ['exit 3'], ship: { push: false }, deploy: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(show(dir, 'rev-parse', 'HEAD'), before, 'nessun commit');
  const failed = result.steps.find((s) => s.status === 'failed');
  assert.equal(failed.step, 'check');
  assert.match(failed.error, /exit 3/, 'si dice quale passo e perche\'');
});

test('ship: senza file non si committa niente', async () => {
  const { dir } = tempRepo();
  const result = await ship({ dir, files: [], config: { checks: [], ship: { push: false } } });
  assert.equal(result.ok, false);
  assert.match(result.steps[0].error, /no files|changed no files/);
});

test('ship: un ramo diverso da quello dichiarato non si spinge', async () => {
  // Meglio fermarsi e dirlo che pubblicare altrove: quasi sempre e' una
  // configurazione sbagliata, e il push e' la parte difficile da annullare.
  const { dir, git } = tempRepo({ 'a.txt': 'uno\n' });
  git('checkout', '-q', '-b', 'sperimentale');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'due\n');

  const result = await ship({
    dir,
    files: ['a.txt'],
    message: 'su un ramo laterale',
    config: { checks: [], ship: { push: true, branch: 'main', remote: 'origin' }, deploy: {} },
  });

  assert.equal(result.ok, true, 'il commit e\' comunque valido');
  assert.equal(result.pushed, false);
  const skipped = result.steps.find((s) => s.step === 'push');
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /sperimentale/);
});

test('ship: gli eventi raccontano i passi nell\'ordine in cui succedono', async () => {
  const { dir } = tempRepo({ 'a.txt': 'uno\n' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'due\n');
  const steps = [];

  await ship({
    dir,
    files: ['a.txt'],
    message: 'con eventi',
    config: { checks: ['true'], ship: { push: false }, deploy: {} },
    onEvent: (e) => { if (e.status !== 'log') steps.push(`${e.step}:${e.status}`); },
  });

  assert.deepEqual(steps, ['files:ok', 'check:running', 'check:ok', 'commit:ok']);
});

test('fallbackMessage: la prima riga del prompt, tagliata dove serve', () => {
  assert.match(fallbackMessage('Cambia il colore del bottone\n\nfacendolo rosso'), /^Cambia il colore del bottone\n/);
  assert.match(fallbackMessage('x'.repeat(200)).split('\n')[0], /…$/);
  assert.match(fallbackMessage(''), /^change from the inspector/);
});
