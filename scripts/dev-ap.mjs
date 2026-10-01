#!/usr/bin/env node
/**
 * Run this piece inside a real, locally running Activepieces: no Docker, no image rebuild, and
 * nothing to commit anywhere but this repository.
 *
 * This is not .ap-src/. That one is a sparse, blobless checkout of the four packages the bundler
 * needs; it cannot run the application. This takes a full checkout of the same commit into
 * .ap-dev/ (git-ignored, throwaway, ~3 GB installed), copies the piece into it, and starts
 * Activepieces' own `npm start`. Developers keep editing packages/orocommerce/src here; a watcher
 * mirrors every save into the copy, and Activepieces' dev-piece watcher rebuilds it in place.
 *
 * The copy is one-way on purpose. Activepieces expects a piece to sit inside its workspace and
 * build with its tooling, which needs two small changes to package.json and tsconfig.json that must
 * never land in the published package. Applying them to the copy keeps this repository's own files
 * untouched. A symlink was tried instead and does not work at all: bun drops a symlinked workspace
 * member from the lockfile, and turbo refuses the entire workspace with "Workspace package resolves
 * outside repository root", so `npm start` dies before it reaches the piece.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join(REPO_ROOT, '.ap-pin');
const PIECE_DIR = join(REPO_ROOT, 'packages', 'orocommerce');

const UPSTREAM = 'https://github.com/activepieces/activepieces.git';

const DEV_DIR = join(REPO_ROOT, '.ap-dev');

/**
 * Upstream keeps custom pieces in packages/pieces/custom/* (an empty, already-globbed workspace
 * slot), so the copy goes there.
 */
const DEV_PIECE_PATH = join('packages', 'pieces', 'custom', 'orocommerce');

/** Only these four are copied. Everything else in the piece is for this repository's own tooling. */
const COPIED = ['package.json', 'src', 'tsconfig.json', 'tsconfig.lib.json'];

/** The folder name Activepieces matches AP_DEV_PIECES against. */
const PIECE_FOLDER = 'orocommerce';

const MIN_BUN = '1.3.14';
const WATCH_DEBOUNCE_MS = 200;

const VALID_FLAGS = ['--reset'];

const args = process.argv.slice(2);
const unknownArgs = args.filter((arg) => !VALID_FLAGS.includes(arg));
const doReset = args.includes('--reset');

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function run(command, cmdArgs, options = {}) {
  const result = spawnSync(command, cmdArgs, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${cmdArgs.join(' ')} failed with exit code ${result.status}`);
  }
}

/**
 * bun runs the lifecycle scripts of Activepieces' trustedDependencies, and one of them,
 * redis-memory-server, falls back to compiling redis from source when it cannot fetch a prebuilt
 * binary. That compile needs pkg-config and a modern GNU make, which plenty of macOS machines do
 * not have, and it fails the whole install. The second attempt succeeds because the package is
 * already extracted by then, and the server is unaffected either way: redis-memory-server fetches
 * the binary it actually uses at runtime, into node_modules/.cache.
 */
function runWithRetry(command, cmdArgs, options = {}) {
  const first = spawnSync(command, cmdArgs, { stdio: 'inherit', ...options });
  if (first.status === 0) return;
  console.warn(`\n${command} ${cmdArgs.join(' ')} failed once, retrying...\n`);
  const second = spawnSync(command, cmdArgs, { stdio: 'inherit', ...options });
  if (second.status === 0) return;
  throw new Error(
    `${command} ${cmdArgs.join(' ')} failed twice.\n` +
      'If the output above mentions redis-memory-server, pkg-config or GNU make, the install tried ' +
      'to compile redis from source. Running the command again usually clears it, or install ' +
      'pkg-config (`brew install pkg-config`) and retry.'
  );
}

function capture(command, cmdArgs, options = {}) {
  const result = spawnSync(command, cmdArgs, { encoding: 'utf8', ...options });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function readPin() {
  if (!existsSync(PIN_FILE)) die('.ap-pin is missing.');
  const pin = readFileSync(PIN_FILE, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) {
    die(`.ap-pin must hold one full 40-character lowercase commit sha, got: ${JSON.stringify(pin)}.`);
  }
  return pin;
}

// ---------------------------------------------------------------------------
// a. Node gate
// ---------------------------------------------------------------------------

/**
 * Activepieces' own tools/setup-dev.js accepts v22.15+ or v24 and nothing else - not "22.15 or
 * newer", so v23 and v25 are refused there too. Checking here first turns a failure three minutes
 * into a clone into a failure on line one.
 */
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = (major === 22 && minor >= 15) || major === 24;
  if (!ok) {
    die(
      `Activepieces dev mode needs Node v22.15+ or v24, this is v${process.versions.node}.\n` +
        'Switch with `nvm use 24` (or `fnm use 24`) and run again.'
    );
  }
  console.log(`Node v${process.versions.node}: ok.`);
}

// ---------------------------------------------------------------------------
// b. Tool gate
// ---------------------------------------------------------------------------

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function checkBun() {
  const version = capture('bun', ['--version']);
  if (version === null) {
    die(
      'bun is not on PATH, and Activepieces installs its dependencies with it.\n' +
        'Install it with `curl -fsSL https://bun.sh/install | bash` or `brew install oven-sh/bun/bun`.'
    );
  }
  if (compareVersions(version, MIN_BUN) < 0) {
    console.warn(`Warning: bun ${version} is older than ${MIN_BUN}, the oldest version proven here.`);
  } else {
    console.log(`bun ${version}: ok.`);
  }
}

/**
 * The engine spawns AP_DENO_PATH directly with a minimal environment, so it has to be a real
 * binary: an npm .bin shim starts with `#!/usr/bin/env node` and dies with exit 127 because node is
 * not on that PATH. Activepieces' setup-dev.js runs `npm install -g deno` when it cannot find one,
 * which writes into the global node tree. Refusing here keeps that from ever happening.
 */
function isNodeShim(path) {
  try {
    const header = readFileSync(path).subarray(0, 32).toString('utf8');
    return header.startsWith('#!/usr/bin/env node');
  } catch {
    return true;
  }
}

function checkDeno() {
  const found = capture(process.platform === 'win32' ? 'where' : 'which', ['deno']);
  const path = found ? found.split('\n')[0].trim() : null;
  if (!path) {
    die(
      'deno is not on PATH, and the Activepieces engine needs it to run code steps.\n' +
        'Install it one of these ways, then run again:\n' +
        '  brew install deno\n' +
        '  curl -fsSL https://deno.land/install.sh | sh\n' +
        'Do not let Activepieces install it for you: its setup script falls back to ' +
        '`npm install -g deno`, which writes into your global Node installation.'
    );
  }
  if (isNodeShim(path)) {
    die(
      `deno on PATH (${path}) is an npm shim script, not a real binary.\n` +
        'The engine spawns it with a minimal environment, where a shim exits 127. ' +
        'Install a real one with `brew install deno` or `curl -fsSL https://deno.land/install.sh | sh`.'
    );
  }
  console.log(`deno at ${path}: ok.`);
}

// ---------------------------------------------------------------------------
// c. Checkout
// ---------------------------------------------------------------------------

function headOf(dir) {
  return capture('git', ['-C', dir, 'rev-parse', 'HEAD']);
}

function ensureCheckout({ dir, label, url, pin }) {
  if (existsSync(dir)) {
    if (!existsSync(join(dir, '.git'))) {
      die(`${label} exists but is not a git checkout. Delete it and run again:\n  rm -rf ${dir}`);
    }
    const head = headOf(dir);
    if (head !== pin) {
      die(
        `${label} is at ${head}, but .ap-pin says ${pin}.\n` +
          'Nothing is re-checked-out automatically, because the tree may hold work in progress.\n' +
          `Delete it and run again:\n  npm run dev:ap -- --reset\nor\n  rm -rf ${dir}`
      );
    }
    console.log(`${label}: reusing the existing checkout.`);
    return false;
  }

  console.log(
    `${label}: first run, cloning Activepieces. Expect 1 to 15 minutes depending on the network, ` +
      'and about 3 GB once installed.'
  );
  const started = Date.now();
  run('git', ['clone', '--filter=blob:none', url, dir]);
  run('git', ['-C', dir, 'checkout', '--quiet', pin]);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`${label}: cloned in ${seconds}s. The install below adds roughly 2.5 GB more.`);
  return true;
}

// ---------------------------------------------------------------------------
// d. Piece copy and the two overlays
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Two changes, applied to the copy and never to this repository's own files:
 *
 * - build: packages/orocommerce/package.json builds with scripts/bundle.mjs, which is two levels up
 *   here and does not exist inside Activepieces. Inside the workspace the piece has to build the way
 *   every upstream piece does, and the `cp` half is not optional: Activepieces loads a dev piece by
 *   requiring <dist>/package.json first, and the pre-build before the server starts does not copy it.
 * - extends: tsconfig.base.json is two levels up here and four levels up there.
 */
function applyOverlay(copyDir) {
  const manifestPath = join(copyDir, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.scripts = { ...manifest.scripts, build: 'tsc -p tsconfig.lib.json && cp package.json dist/' };
  writeJson(manifestPath, manifest);

  const tsconfigPath = join(copyDir, 'tsconfig.json');
  const tsconfig = readJson(tsconfigPath);
  tsconfig.extends = '../../../../tsconfig.base.json';
  writeJson(tsconfigPath, tsconfig);
}

/** Copy src over the destination and delete whatever the source no longer has. */
function mirrorTree(from, to) {
  cpSync(from, to, { recursive: true, force: true });
  pruneExtras(from, to);
}

function pruneExtras(from, to) {
  for (const entry of readdirSync(to)) {
    const there = join(to, entry);
    const here = join(from, entry);
    if (!existsSync(here)) {
      rmSync(there, { recursive: true, force: true });
      continue;
    }
    if (statSync(there).isDirectory()) pruneExtras(here, there);
  }
}

function copyPiece(copyDir) {
  const isNew = !existsSync(copyDir);
  mkdirSync(copyDir, { recursive: true });
  for (const entry of COPIED) {
    const from = join(PIECE_DIR, entry);
    const to = join(copyDir, entry);
    if (statSync(from).isDirectory()) mirrorTree(from, to);
    else cpSync(from, to, { force: true });
  }
  applyOverlay(copyDir);
  return isNew;
}

// ---------------------------------------------------------------------------
// e. .env.dev
// ---------------------------------------------------------------------------

/**
 * Both of these have to live in the file, not in the shell. Activepieces runs the server under
 * turbo, which strips every variable outside turbo.json globalPassThroughEnv, and neither of these
 * is in it. Exported, AP_DEV_PIECES produces the worst outcome available: the setup script builds
 * this piece while the server goes on serving the default two.
 *
 * AP_REUSE_SANDBOX is the one that is not obvious. With AP_ENVIRONMENT=dev, canReuseSandbox()
 * returns true, so the engine process is reused between runs and keeps every piece it has loaded in
 * require.cache. The metadata side of the API does clear its own cache, so labels and new action
 * names appear in the builder - but "Test step" goes on running the previous code, and an action
 * added after the server started fails with ENTITY_NOT_FOUND. Turning reuse off costs a fraction of
 * a second per test run and makes the loop honest.
 */
const ENV_SETTINGS = [
  ['AP_DEV_PIECES', `"${PIECE_FOLDER}"`],
  ['AP_REUSE_SANDBOX', 'false'],
];

function writeEnvDev(checkoutDir) {
  const envPath = join(checkoutDir, '.env.dev');
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of ENV_SETTINGS) {
    const line = `${key}=${value}`;
    // Every line for the key, not only the first: dotenv keeps the last one it reads, so a
    // duplicate further down would otherwise win silently.
    const pattern = new RegExp(`^${key}=.*$`, 'gm');
    if (text.match(pattern)) {
      text = text.replace(pattern, line);
    } else {
      text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`;
    }
  }
  writeFileSync(envPath, text);
  console.log(`.env.dev: ${ENV_SETTINGS.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
}

// ---------------------------------------------------------------------------
// g. Watcher
// ---------------------------------------------------------------------------

function startWatcher(copyDir) {
  const srcFrom = join(PIECE_DIR, 'src');
  const srcTo = join(copyDir, 'src');
  let timer = null;
  let manifestTouched = false;

  const sync = () => {
    timer = null;
    try {
      mirrorTree(srcFrom, srcTo);
      if (manifestTouched) {
        manifestTouched = false;
        cpSync(join(PIECE_DIR, 'package.json'), join(copyDir, 'package.json'), { force: true });
        applyOverlay(copyDir);
        console.log('[dev-ap] synced src and package.json (overlay re-applied)');
      } else {
        console.log('[dev-ap] synced src');
      }
    } catch (error) {
      console.error(`[dev-ap] sync failed: ${error.message}`);
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, WATCH_DEBOUNCE_MS);
  };

  const watchers = [
    watch(srcFrom, { recursive: true }, schedule),
    watch(join(PIECE_DIR, 'package.json'), () => {
      manifestTouched = true;
      schedule();
    }),
  ];

  console.log(`[dev-ap] watching ${relative(REPO_ROOT, srcFrom)} and packages/orocommerce/package.json`);
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

// ---------------------------------------------------------------------------
// j. --reset
// ---------------------------------------------------------------------------

async function reset() {
  const targets = [DEV_DIR].filter((dir) => existsSync(dir));
  if (targets.length === 0) {
    console.log('Nothing to delete: .ap-dev/ does not exist.');
    return;
  }
  console.log('This will permanently delete:');
  for (const dir of targets) console.log(`  ${relative(REPO_ROOT, dir)}/`);
  console.log('Nothing in this repository is touched.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type yes to confirm: ');
  rl.close();
  if (answer.trim() !== 'yes') {
    console.log('Nothing was deleted.');
    return;
  }
  for (const dir of targets) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Deleted ${relative(REPO_ROOT, dir)}/`);
  }
}

// ---------------------------------------------------------------------------
// h. Start
// ---------------------------------------------------------------------------

function start(checkoutDir, stopWatcher) {
  const child = spawn('npm', ['start'], { cwd: checkoutDir, stdio: 'inherit' });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopWatcher();
    child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('exit', (code) => {
    stopWatcher();
    process.exit(code ?? 0);
  });
}

async function main() {
  if (unknownArgs.length > 0) {
    die(
      `Unknown option: ${unknownArgs.join(' ')}\n` +
        `Valid flags: ${VALID_FLAGS.join(', ')}. Run with no flags to start Activepieces.`
    );
  }

  if (doReset) {
    await reset();
    return;
  }

  checkNode();
  checkBun();
  checkDeno();

  const pin = readPin();
  const checkoutDir = DEV_DIR;

  console.log(`Activepieces pin: ${pin}`);
  ensureCheckout({ dir: DEV_DIR, label: '.ap-dev', url: UPSTREAM, pin });

  const copyDir = join(checkoutDir, DEV_PIECE_PATH);
  const isNewCopy = copyPiece(copyDir);
  console.log(`Piece copied into ${relative(REPO_ROOT, copyDir)}${isNewCopy ? ' (new)' : ''}.`);

  writeEnvDev(checkoutDir);

  // bun has to re-read the workspace once the new member exists; after that the links persist.
  // The root check also covers a half-finished or hand-deleted install.
  const needsInstall =
    isNewCopy ||
    !existsSync(join(copyDir, 'node_modules')) ||
    !existsSync(join(checkoutDir, 'node_modules'));
  if (needsInstall) {
    console.log('Running bun install so the new workspace member is linked...');
    runWithRetry('bun', ['install'], { cwd: checkoutDir });
  }

  const stopWatcher = startWatcher(copyDir);
  console.log(`env: ${relative(REPO_ROOT, join(checkoutDir, '.env.dev'))}`);
  console.log('\nStarting Activepieces. Sign in at http://localhost:4200 as dev@ap.com / 12345678.\n');
  start(checkoutDir, stopWatcher);
}

main().catch((error) => die(error.message));
