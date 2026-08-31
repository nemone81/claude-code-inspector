// Publishing a task: checks, commit, push, and — if the project says how —
// deploy.
//
// The bridge deliberately knows nothing about Vercel, Netlify or any other
// host. What it knows is that a project can *declare* how it is published, in
// a file that lives in the repo:
//
//   .claude-inspector.json
//   {
//     "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
//     "ship":   { "push": true, "branch": "main" },
//     "deploy": { "run": "./deploy/deploy.sh", "status": "npx vercel ls --prod" }
//   }
//
// ⚠️ The commands come from that file and from nowhere else. They are never
// taken from the HTTP request, so a page — or an extension that has been
// tampered with — cannot ask the bridge to run something. The trust boundary
// is the same one npm scripts already have: whoever can write to the repo can
// already run code on this machine.
//
// Detection exists only to *propose*: when the file is missing we look at what
// the repo contains and suggest a configuration for a human to confirm. A
// guessed pipeline that runs by itself is exactly the kind of automation
// nobody ends up trusting.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { git, isRepo, normalizeFiles } = require('./git-tools');

const CONFIG_FILE = '.claude-inspector.json';
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

function configPath(dir) {
  return path.join(dir, CONFIG_FILE);
}

function readShipConfig(dir) {
  try {
    const raw = fs.readFileSync(configPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      checks: Array.isArray(parsed.checks) ? parsed.checks.filter((c) => typeof c === 'string') : [],
      ship: {
        push: parsed.ship?.push !== false,
        branch: typeof parsed.ship?.branch === 'string' ? parsed.ship.branch : null,
        remote: typeof parsed.ship?.remote === 'string' ? parsed.ship.remote : 'origin',
      },
      deploy: {
        run: typeof parsed.deploy?.run === 'string' ? parsed.deploy.run : null,
        status: typeof parsed.deploy?.status === 'string' ? parsed.deploy.status : null,
        // How long to keep asking `status` before giving up and saying so.
        waitSeconds: Number.isFinite(parsed.deploy?.waitSeconds) ? parsed.deploy.waitSeconds : 0,
        readyWhen: typeof parsed.deploy?.readyWhen === 'string' ? parsed.deploy.readyWhen : null,
      },
    };
  } catch {
    return null;
  }
}

function writeShipConfig(dir, config) {
  fs.writeFileSync(configPath(dir), `${JSON.stringify(config, null, 2)}\n`);
  return readShipConfig(dir);
}

/**
 * What this repo looks like it uses — a suggestion, never an action.
 *
 * Each hit says what was seen, so the panel can show the evidence instead of
 * an oracle: "there is a .vercel/project.json here" is checkable by the person
 * reading it, "this is a Vercel project" is not.
 */
function detectProject(dir) {
  const seen = [];
  const exists = (p) => fs.existsSync(path.join(dir, p));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch { /* not a node project */ }

  const scripts = pkg?.scripts ?? {};
  const runner = exists('pnpm-lock.yaml')
    ? 'pnpm'
    : exists('yarn.lock')
      ? 'yarn'
      : exists('bun.lockb')
        ? 'bun run'
        : 'npm run';

  const checks = ['lint', 'typecheck', 'test']
    .filter((s) => scripts[s])
    .map((s) => `${runner} ${s}`);
  if (checks.length) seen.push(`package.json: ${checks.length} script(s) di verifica`);

  const deploy = { run: null, status: null };

  if (exists('.vercel/project.json')) {
    seen.push('.vercel/project.json');
    // Deploy parte dal push: qui serve solo sapere com'è andata.
    deploy.status = 'npx vercel ls --prod';
  } else if (exists('netlify.toml')) {
    seen.push('netlify.toml');
    deploy.status = 'npx netlify status';
  } else if (scripts.deploy) {
    seen.push('package.json: script "deploy"');
    deploy.run = `${runner} deploy`;
  } else if (exists('deploy/deploy.sh')) {
    seen.push('deploy/deploy.sh');
    deploy.run = './deploy/deploy.sh';
  }

  const workflows = path.join(dir, '.github', 'workflows');
  if (fs.existsSync(workflows)) {
    const files = fs.readdirSync(workflows).filter((f) => /deploy|release|publish/i.test(f));
    if (files.length) seen.push(`.github/workflows/${files[0]}`);
  }

  return {
    seen,
    suggestion: {
      checks,
      ship: { push: true },
      ...(deploy.run || deploy.status ? { deploy } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Running a declared command
 * ------------------------------------------------------------------ */

/**
 * Runs one command from the config, streaming its output.
 *
 * `shell: true` is deliberate: the declared commands are shell lines
 * (`pnpm test`, `./deploy/deploy.sh`), written by whoever owns the repo. See
 * the trust note at the top of this file.
 */
function runCommand(dir, command, onLine) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: dir, shell: true, env: { ...process.env, CI: '1' } });
    let output = '';
    let done = false;

    const finish = (code, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.slice(-16 * 1024), note });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124, 'timed out');
    }, STEP_TIMEOUT_MS);

    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      // Solo le righe non vuote, e una alla volta: il pannello mostra un log,
      // non un blocco di testo che arriva tutto insieme alla fine.
      for (const line of text.split('\n')) if (line.trim()) onLine?.(line.trimEnd());
    };

    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => {
      output += String(err.message);
      finish(1, err.message);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/** Un messaggio di commit onesto quando non ce n'è uno scritto meglio. */
function fallbackMessage(prompt) {
  const first = String(prompt || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) || 'change from the inspector';
  const subject = first.length > 68 ? `${first.slice(0, 67)}…` : first;
  return `${subject}\n\nModifica arrivata dall'estensione, sull'elemento selezionato nel browser.`;
}

/**
 * Publica i file di un task.
 *
 * Ogni passo manda un evento prima di partire e uno alla fine: chi guarda il
 * pannello deve poter vedere *dove* si è fermato, non solo che si è fermato.
 */
async function ship({ dir, files, message, prompt, config, onEvent = () => {} }) {
  const cfg = config ?? readShipConfig(dir) ?? { checks: [], ship: { push: true, remote: 'origin' }, deploy: {} };
  const steps = [];
  const record = (step, status, extra = {}) => {
    const event = { step, status, ...extra };
    steps.push(event);
    onEvent(event);
    return event;
  };

  if (!(await isRepo(dir))) {
    record('git', 'failed', { error: 'not a git repository' });
    return { ok: false, steps };
  }

  const rel = normalizeFiles(dir, files || []);
  if (!rel.length) {
    record('git', 'failed', { error: 'the task changed no files' });
    return { ok: false, steps };
  }

  // ⚠️ Si committano **solo i file di questo task**, mai `git add -A`: nel
  // repo può esserci altro lavoro in corso, e pubblicarlo di straforo perché
  // era aperto nello stesso momento è il modo più rapido per non fidarsi più
  // di questo bottone.
  record('files', 'ok', { files: rel });

  for (const command of cfg.checks) {
    record('check', 'running', { command });
    const result = await runCommand(dir, command, (line) => onEvent({ step: 'check', status: 'log', command, line }));
    if (!result.ok) {
      record('check', 'failed', { command, output: result.output, error: result.note || `exit ${result.code}` });
      return { ok: false, steps };
    }
    record('check', 'ok', { command });
  }

  try {
    await git(dir, ['add', '--', ...rel]);
    const subject = (message && message.trim()) || fallbackMessage(prompt);
    await git(dir, ['commit', '-m', subject]);
  } catch (err) {
    record('commit', 'failed', { error: String(err.message).slice(0, 500) });
    return { ok: false, steps };
  }

  const sha = (await git(dir, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  record('commit', 'ok', { sha, branch });

  if (cfg.ship?.push) {
    // Un ramo dichiarato che non è quello su cui si sta lavorando è quasi
    // sempre un errore di configurazione, e spingere altrove sarebbe peggio
    // che fermarsi.
    if (cfg.ship.branch && cfg.ship.branch !== branch) {
      record('push', 'skipped', {
        error: `sei su "${branch}", la configurazione dice "${cfg.ship.branch}"`,
      });
      return { ok: true, steps, sha, branch, pushed: false };
    }

    record('push', 'running', { branch });
    const result = await runCommand(dir, `git push ${cfg.ship.remote || 'origin'} HEAD`, (line) =>
      onEvent({ step: 'push', status: 'log', line }),
    );
    if (!result.ok) {
      record('push', 'failed', { output: result.output, error: result.note || `exit ${result.code}` });
      return { ok: false, steps, sha, branch, pushed: false };
    }
    record('push', 'ok', { branch });
  }

  if (cfg.deploy?.run) {
    record('deploy', 'running', { command: cfg.deploy.run });
    const result = await runCommand(dir, cfg.deploy.run, (line) =>
      onEvent({ step: 'deploy', status: 'log', line }),
    );
    if (!result.ok) {
      record('deploy', 'failed', { output: result.output, error: result.note || `exit ${result.code}` });
      return { ok: false, steps, sha, branch, pushed: true };
    }
    record('deploy', 'ok', {});
  } else if (cfg.ship?.push) {
    // Dove il deploy parte dal push, dirlo è l'unica cosa onesta: il bridge
    // non ha modo di sapere quando sarà online.
    record('deploy', 'external', {});
  }

  return { ok: true, steps, sha, branch, pushed: !!cfg.ship?.push };
}

/**
 * Chiede al progetto com'è andata, finché non è pronto o finché non scade il
 * tempo dichiarato.
 *
 * `readyWhen` è una stringa che deve comparire nell'output: senza, si mostra
 * una volta sola quello che il comando dice e basta. Il bridge non interpreta
 * l'output di nessun fornitore.
 */
async function watchDeploy({ dir, config, onEvent = () => {} }) {
  const cfg = config ?? readShipConfig(dir);
  const command = cfg?.deploy?.status;
  if (!command) return { ok: true, watched: false };

  const deadline = Date.now() + Math.max(0, cfg.deploy.waitSeconds || 0) * 1000;

  for (;;) {
    const result = await runCommand(dir, command, () => {});
    const ready = cfg.deploy.readyWhen ? result.output.includes(cfg.deploy.readyWhen) : true;
    onEvent({ step: 'status', status: ready ? 'ok' : 'waiting', output: result.output.slice(-2000) });
    if (ready || Date.now() >= deadline) {
      return { ok: true, watched: true, ready, output: result.output.slice(-2000) };
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

module.exports = {
  CONFIG_FILE,
  readShipConfig,
  writeShipConfig,
  detectProject,
  runCommand,
  fallbackMessage,
  ship,
  watchDeploy,
};
