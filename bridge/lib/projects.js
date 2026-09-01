// Quale progetto tocca l'agente, quando a dirlo e' la pagina.
//
// Una pagina puo' dichiarare il proprio progetto in un <meta>:
//
//     <meta name="claude-inspector-project" content="tirelli-intranet">
//
// E' comodo — cambi tab, cambia progetto, senza riscrivere il path nel
// pannello — ma sposta una decisione di sicurezza fuori dalla tua macchina:
// quel meta lo scrive chiunque serva la pagina, e le pagine si guardano anche
// in produzione. Per questo il valore dichiarato non e' mai un path da usare
// cosi' com'e': e' una *richiesta* da risolvere contro le root che hai
// dichiarato tu, in locale. Fuori da quelle root non si va, e nemmeno sulla
// root stessa — puntarci la cwd darebbe a un solo meta tag accesso in
// scrittura a tutti i repo che contiene.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.claude-inspector');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_DECLARED = 512;

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Il path reale, seguendo i symlink: senza questo una scorciatoia dentro una root ne esce. */
function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** true se `target` sta *dentro* `root` (la root stessa non conta). */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Le root consentite, da INSPECTOR_PROJECT_ROOTS o da ~/.claude-inspector/config.json.
 * Rilette a ogni chiamata (sono due stat): il file si modifica a mano, e un
 * bridge da riavviare per una riga di config e' un bridge che non si aggiorna.
 */
function loadRoots({ configFile = CONFIG_FILE, env = process.env } = {}) {
  let declared = [];

  if (env.INSPECTOR_PROJECT_ROOTS) {
    declared = env.INSPECTOR_PROJECT_ROOTS.split(path.delimiter);
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (Array.isArray(raw.roots)) declared = raw.roots;
    } catch { /* nessuna config: nessuna root, le pagine non decidono niente */ }
  }

  const roots = [];
  for (const entry of declared) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const real = realOrNull(path.resolve(expandHome(entry.trim())));
    if (real && isDir(real) && !roots.includes(real)) roots.push(real);
  }
  return roots;
}

class ProjectRefused extends Error {
  constructor(message, roots) {
    super(message);
    this.name = 'ProjectRefused';
    this.roots = roots || [];
  }
}

/**
 * Risolve quello che la pagina ha dichiarato in una directory di lavoro.
 *
 * Accetta un nome (`tirelli-intranet`, cercato sotto ogni root) o un path
 * assoluto — comodo in locale, ma pubblicare un path assoluto nell'HTML di
 * produzione regala username e nomi dei repo a chiunque apra il sorgente:
 * meglio il nome. In entrambi i casi vale la stessa regola: dentro una root,
 * o niente.
 *
 * @throws {ProjectRefused}
 */
function resolveDeclaredProject(declared, { roots = loadRoots() } = {}) {
  const raw = typeof declared === 'string' ? declared.trim() : '';
  if (!raw) throw new ProjectRefused('nessun progetto dichiarato', roots);
  if (raw.length > MAX_DECLARED) throw new ProjectRefused('progetto dichiarato troppo lungo', roots);
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ProjectRefused('progetto dichiarato non valido', roots);

  if (!roots.length) {
    throw new ProjectRefused(
      `nessuna root consentita: "${raw}" non puo' essere risolto. Dichiarale in ${CONFIG_FILE} ({"roots":["~/Projects"]}) o in INSPECTOR_PROJECT_ROOTS.`,
      roots,
    );
  }

  const absolute = raw.startsWith('/') || raw.startsWith('~');
  const candidates = absolute
    ? [path.resolve(expandHome(raw))]
    : roots.map((root) => path.resolve(root, raw));

  for (const candidate of candidates) {
    const real = realOrNull(candidate);
    if (!real || !isDir(real)) continue;
    if (roots.some((root) => isInside(root, real))) return real;
  }

  const where = roots.join(', ');
  throw new ProjectRefused(
    absolute
      ? `"${raw}" non e' una directory dentro le root consentite (${where})`
      : `progetto "${raw}" non trovato nelle root consentite (${where})`,
    roots,
  );
}

module.exports = { loadRoots, resolveDeclaredProject, ProjectRefused, CONFIG_FILE, CONFIG_DIR };
