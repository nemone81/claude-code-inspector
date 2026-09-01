const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { loadRoots, resolveDeclaredProject, ProjectRefused } = require('../lib/projects');

// I test girano su directory reali: la sicurezza qui sta tutta in realpath e
// nei confronti tra path, e un mock del filesystem verificherebbe il mock.
function makeRoot(...projects) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-roots-')));
  for (const name of projects) fs.mkdirSync(path.join(root, name), { recursive: true });
  return root;
}

test('un nome si risolve nella directory sotto la root', () => {
  const root = makeRoot('tirelli-intranet');
  assert.equal(
    resolveDeclaredProject('tirelli-intranet', { roots: [root] }),
    path.join(root, 'tirelli-intranet'),
  );
});

test('con piu root vince la prima che contiene quel nome', () => {
  const a = makeRoot('solo-in-a');
  const b = makeRoot('condiviso');
  assert.equal(resolveDeclaredProject('condiviso', { roots: [a, b] }), path.join(b, 'condiviso'));
});

test('un nome che non esiste sotto nessuna root e rifiutato', () => {
  const root = makeRoot('esiste');
  assert.throws(
    () => resolveDeclaredProject('non-esiste', { roots: [root] }),
    (e) => e instanceof ProjectRefused && /non trovato/.test(e.message),
  );
});

test('un path assoluto dentro la root e accettato', () => {
  const root = makeRoot('app');
  const dir = path.join(root, 'app');
  assert.equal(resolveDeclaredProject(dir, { roots: [root] }), dir);
});

test('un path assoluto fuori dalle root e rifiutato', () => {
  const root = makeRoot('app');
  const fuori = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-fuori-')));
  assert.throws(
    () => resolveDeclaredProject(fuori, { roots: [root] }),
    (e) => e instanceof ProjectRefused && /root consentite/.test(e.message),
  );
});

// La riga di difesa vera: una pagina ostile dichiara "../../.ssh" e si aspetta
// che il join con la root la porti dove vuole lei.
test('la risalita con .. non esce dalla root', () => {
  const root = makeRoot('app');
  const fratello = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-vicino-')));
  const risalita = path.relative(root, fratello); // ../inspector-vicino-xxxx
  assert.throws(
    () => resolveDeclaredProject(risalita, { roots: [root] }),
    (e) => e instanceof ProjectRefused,
  );
});

test('un symlink dentro la root che punta fuori e rifiutato', () => {
  const root = makeRoot();
  const fuori = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-target-')));
  fs.symlinkSync(fuori, path.join(root, 'scorciatoia'));
  assert.throws(
    () => resolveDeclaredProject('scorciatoia', { roots: [root] }),
    (e) => e instanceof ProjectRefused,
  );
});

// Puntare la cwd sulla root darebbe a un solo meta tag accesso in scrittura a
// tutti i repo che contiene.
test('la root stessa non e un progetto', () => {
  const root = makeRoot('app');
  assert.throws(() => resolveDeclaredProject(root, { roots: [root] }), (e) => e instanceof ProjectRefused);
  assert.throws(() => resolveDeclaredProject('.', { roots: [root] }), (e) => e instanceof ProjectRefused);
});

test('un file non e un progetto', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'note.txt'), 'x');
  assert.throws(() => resolveDeclaredProject('note.txt', { roots: [root] }), (e) => e instanceof ProjectRefused);
});

test('senza root consentite nessuna dichiarazione passa', () => {
  assert.throws(
    () => resolveDeclaredProject('qualsiasi-cosa', { roots: [] }),
    (e) => e instanceof ProjectRefused && /nessuna root consentita/.test(e.message),
  );
});

test('valori vuoti, troppo lunghi o con caratteri di controllo sono rifiutati', () => {
  const root = makeRoot('app');
  const opts = { roots: [root] };
  assert.throws(() => resolveDeclaredProject('', opts), (e) => e instanceof ProjectRefused);
  assert.throws(() => resolveDeclaredProject('   ', opts), (e) => e instanceof ProjectRefused);
  assert.throws(() => resolveDeclaredProject(null, opts), (e) => e instanceof ProjectRefused);
  assert.throws(() => resolveDeclaredProject('a'.repeat(513), opts), (e) => e instanceof ProjectRefused);
  assert.throws(() => resolveDeclaredProject('app\u0000/x', opts), (e) => e instanceof ProjectRefused);
});

test('gli spazi attorno al nome non contano', () => {
  const root = makeRoot('app');
  assert.equal(resolveDeclaredProject('  app  ', { roots: [root] }), path.join(root, 'app'));
});

test('un progetto annidato sotto la root si dichiara col percorso relativo', () => {
  const root = makeRoot(path.join('clienti', 'tirelli'));
  assert.equal(
    resolveDeclaredProject('clienti/tirelli', { roots: [root] }),
    path.join(root, 'clienti', 'tirelli'),
  );
});

// ─── loadRoots ────────────────────────────────────────────────────────────────

test('loadRoots legge il config, espande ~ e scarta le root inesistenti', () => {
  const root = makeRoot('app');
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-cfg-')), 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ roots: [root, '/non/esiste/affatto', '~'] }));

  const roots = loadRoots({ configFile, env: {} });
  assert.ok(roots.includes(root));
  assert.ok(!roots.includes('/non/esiste/affatto'));
  assert.ok(roots.includes(fs.realpathSync(os.homedir())));
});

test("l'env ha la precedenza sul config", () => {
  const daEnv = makeRoot('app');
  const daConfig = makeRoot('app');
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-cfg-')), 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ roots: [daConfig] }));

  const roots = loadRoots({ configFile, env: { INSPECTOR_PROJECT_ROOTS: daEnv } });
  assert.deepEqual(roots, [daEnv]);
});

test('senza config non ci sono root', () => {
  const roots = loadRoots({ configFile: '/non/esiste/config.json', env: {} });
  assert.deepEqual(roots, []);
});
