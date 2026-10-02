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
 * DEV_AP_REPO and DEV_AP_REF in .env.dev.local pick another source instead: a shallow checkout of
 * that ref in a folder of its own, .ap-dev-<hash>/, so each source keeps its own install and dev
 * database.
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
import { connect } from 'node:net';
import { constants as osConstants } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FOLDER,
  GENERATED_HEADER,
  buildEnvDev,
  changedEnvKeys,
  parseLocalEnv,
  resolveSource,
  strayPieceFolders,
  validMarker,
} from './dev-ap-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join(REPO_ROOT, '.ap-pin');
const PIECE_DIR = join(REPO_ROOT, 'packages', 'orocommerce');

const UPSTREAM = 'https://github.com/activepieces/activepieces.git';

/** The developer's own settings. Git-ignored and outside every checkout, so --reset keeps it. */
const LOCAL_ENV_FILE = join(REPO_ROOT, '.env.dev.local');

/** What a checkout other than the default holds: { repo, ref, commit }, written once it is fetched. */
const MARKER_FILE = '.dev-ap-source.json';

/** The folder name Activepieces matches AP_DEV_PIECES against. */
const PIECE_FOLDER = 'orocommerce';

/** Where Activepieces looks for pieces, and so the only place a second folder of ours matters. */
const PIECES_ROOT = 'packages/pieces';

/**
 * Upstream keeps custom pieces in packages/pieces/custom/* (an empty, already-globbed workspace
 * slot), so the copy goes there.
 */
const DEV_PIECE_SEGMENTS = ['packages', 'pieces', 'custom', PIECE_FOLDER];
const DEV_PIECE_PATH = join(...DEV_PIECE_SEGMENTS);

/** Only these four are copied. Everything else in the piece is for this repository's own tooling. */
const COPIED = ['package.json', 'src', 'tsconfig.json', 'tsconfig.lib.json'];

/** Upstream hard-codes both: the API listens on 3000, and the web app on 4200 proxies /api to it. */
const PORTS = [
  [3000, 'the Activepieces API'],
  [4200, 'the Activepieces web app'],
];

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

function isNodeShim(path) {
  try {
    const header = readFileSync(path).subarray(0, 32).toString('utf8');
    return header.startsWith('#!/usr/bin/env node');
  } catch {
    return true;
  }
}

/**
 * The same lookup as Activepieces' setup-dev.js. The engine spawns AP_DENO_PATH directly with a
 * minimal environment, where an npm .bin shim (`#!/usr/bin/env node`) dies with exit 127, so
 * setup-dev hands it a real binary: deno on PATH when that is one, or else the binary the npm
 * package downloaded into <npm root -g>/deno. Only with no deno on PATH at all, or a shim with
 * nothing behind it, does setup-dev fall back to `npm install -g deno`, which writes into the
 * global Node installation. Refusing exactly those two cases keeps that from happening without
 * turning away a setup Activepieces itself accepts.
 */
function checkDeno() {
  const found = capture(process.platform === 'win32' ? 'where' : 'which', ['deno']);
  const onPath = found ? found.split('\n')[0].trim() : null;
  if (!onPath) {
    die(
      'deno is not on PATH, and the Activepieces engine needs it to run code steps.\n' +
        'Install it one of these ways, then run again:\n' +
        '  brew install deno\n' +
        '  curl -fsSL https://deno.land/install.sh | sh\n' +
        'Do not let Activepieces install it for you: its setup script falls back to ' +
        '`npm install -g deno`, which writes into your global Node installation.'
    );
  }
  if (!isNodeShim(onPath)) {
    console.log(`deno at ${onPath}: ok.`);
    return;
  }
  const npmRoot = capture('npm', ['root', '-g']);
  const fallback = npmRoot
    ? join(npmRoot, 'deno', process.platform === 'win32' ? 'deno.exe' : 'deno')
    : null;
  if (fallback && existsSync(fallback) && !isNodeShim(fallback)) {
    console.log(`deno on PATH (${onPath}) is the npm shim; Activepieces uses ${fallback}: ok.`);
    return;
  }
  die(
    `deno on PATH (${onPath}) is an npm shim script, and there is no real binary behind it at ` +
      `${fallback ?? '<npm root -g>/deno/deno'}.\n` +
      'Activepieces would then run `npm install -g deno`, which writes into your global Node ' +
      'installation. Install a real one with `brew install deno` or ' +
      '`curl -fsSL https://deno.land/install.sh | sh`.'
  );
}

// ---------------------------------------------------------------------------
// c. Ports
// ---------------------------------------------------------------------------

/**
 * A connection test rather than a trial listen: it finds a server bound to either loopback address
 * or to a wildcard one, which is what decides where http://localhost:4200 ends up.
 */
function isPortInUse(port) {
  const probe = (host) =>
    new Promise((resolveProbe) => {
      const socket = connect({ host, port });
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        resolveProbe(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolveProbe(false);
      });
      socket.once('error', () => resolveProbe(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((results) => results.some(Boolean));
}

async function checkPorts() {
  const busy = [];
  for (const [port, user] of PORTS) {
    if (await isPortInUse(port)) busy.push([port, user]);
  }
  if (busy.length > 0) {
    die(
      busy.map(([port, user]) => `Port ${port} is already in use, and ${user} needs it.`).join('\n') +
        '\nStop whatever is listening there and run again. To see what it is:\n' +
        busy.map(([port]) => `  lsof -nP -iTCP:${port} -sTCP:LISTEN`).join('\n') +
        '\nAnother Activepieces dev server, such as one run next to a local Oro, uses the same ports.'
    );
  }
  console.log(`Ports ${PORTS.map(([port]) => port).join(' and ')}: free.`);
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

function readLocalEnv() {
  return existsSync(LOCAL_ENV_FILE) ? parseLocalEnv(readFileSync(LOCAL_ENV_FILE, 'utf8')) : [];
}

/** Rebuilt from the committed file on every run, so nothing a previous run wrote is carried over. */
function writeEnvDev(devDir, local) {
  const committed = spawnSync('git', ['-C', devDir, 'show', 'HEAD:.env.dev'], { encoding: 'utf8' });
  if (committed.status !== 0) {
    die(
      `${relative(REPO_ROOT, devDir)} has no committed .env.dev at HEAD, so there is nothing to ` +
        'build its .env.dev from. Pick a ref of Activepieces that has one.'
    );
  }
  const { text, applied, ignored } = buildEnvDev(committed.stdout, local, ENV_SETTINGS);
  for (const key of ignored) console.warn(`.env.dev.local: ${key} is ignored, this script always sets it.`);
  warnAboutHandEdits(devDir, committed.stdout);
  writeFileSync(join(devDir, '.env.dev'), text);
  console.log(
    `.env.dev: rebuilt from the committed one, with ${ENV_SETTINGS.map(([k, v]) => `${k}=${v}`).join(', ')}.`
  );
  if (applied.length > 0) {
    // Keys only: the values are the developer's and may be secrets.
    console.log(`.env.dev: from .env.dev.local, ${applied.join(', ')}.`);
  }
}

/**
 * A .env.dev without the generated header was written by an earlier version of this script, or by
 * hand. Once, before it is replaced, name the keys that are about to go, so that the developer can
 * move them to .env.dev.local. Names only: the values may be secrets. The script's own two keys
 * are left out, since every run sets them anyway.
 */
function warnAboutHandEdits(devDir, committed) {
  const path = join(devDir, '.env.dev');
  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8');
  if (existing.startsWith(GENERATED_HEADER)) return;
  const keys = changedEnvKeys(existing, committed, ENV_SETTINGS.map(([key]) => key));
  if (keys.length === 0) return;
  console.warn(
    `Warning: ${relative(REPO_ROOT, path)} was edited by hand and is rebuilt now. These keys differ ` +
      `from the committed file and are lost: ${keys.join(', ')}.\n` +
      'Put the ones you still need in .env.dev.local at the repository root, then run again.'
  );
}

// ---------------------------------------------------------------------------
// f. Watcher
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
    // The folder, not the file: an editor's atomic save or a git checkout replaces package.json
    // with a new file, and a watch on the old one goes quiet without an error.
    watch(PIECE_DIR, (_event, name) => {
      if (name !== 'package.json') return;
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
// g. --reset
// ---------------------------------------------------------------------------

function formatSize(dir) {
  const kib = Number((capture('du', ['-sk', dir]) ?? '').split(/\s/)[0]);
  if (!Number.isFinite(kib) || kib <= 0) return 'size unknown';
  return kib >= 1024 * 1024 ? `${(kib / 1024 / 1024).toFixed(1)} GB` : `${Math.ceil(kib / 1024)} MB`;
}

/** The checkout's marker, or null when the file is missing, unreadable or incomplete. */
function readMarker(devDir) {
  try {
    return validMarker(readJson(join(devDir, MARKER_FILE)));
  } catch {
    return null;
  }
}

/** The checkout's HEAD, or a refusal: a sha this cannot read is not one to build on. */
function readHead(devDir, folder) {
  const head = capture('git', ['-C', devDir, 'rev-parse', 'HEAD']);
  if (head === null) {
    die(
      `${folder} has a .git folder, but \`git rev-parse HEAD\` fails in it, so the checkout cannot ` +
        'be trusted. Delete it and run again:\n  npm run dev:ap -- --reset'
    );
  }
  return head;
}

function describeSource(repo, ref) {
  return `${repo === UPSTREAM ? 'upstream Activepieces' : repo} at ${ref}`;
}

/** False for anything that fails to stat, such as a broken symlink: not a checkout, so not listed. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every checkout but the current one: each source has its own, and --reset only ever deletes that. */
function listOtherCheckouts(folder) {
  const others = readdirSync(REPO_ROOT).filter(
    (name) => name.startsWith(DEFAULT_FOLDER) && name !== folder && isDirectory(join(REPO_ROOT, name))
  );
  if (others.length === 0) return;
  console.log('Other checkouts, which --reset does not touch:');
  for (const name of others) {
    const dir = join(REPO_ROOT, name);
    const marker = readMarker(dir);
    let what = 'source unknown';
    if (name === DEFAULT_FOLDER) what = 'upstream Activepieces at .ap-pin';
    else if (marker) what = describeSource(marker.repo, marker.ref);
    console.log(`  ${name}/  ${formatSize(dir)}  ${what}`);
  }
}

async function reset(folder, devDir) {
  listOtherCheckouts(folder);
  if (!existsSync(devDir)) {
    console.log(`Nothing to delete: ${folder}/ does not exist.`);
    return;
  }
  console.log(
    `This will permanently delete ${folder}/: the checkout, its .env.dev, and the dev database ` +
      'with the flows and connections made in it.\n' +
      '.env.dev.local and everything else in this repository are kept.'
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // question() never settles when stdin closes, and the process would then exit 0 without an
  // answer. A closed stdin counts as no.
  const answer = await new Promise((resolveAnswer) => {
    rl.once('close', () => resolveAnswer(null));
    rl.question('Type yes to confirm: ').then(resolveAnswer, () => resolveAnswer(null));
  });
  rl.close();
  if (answer === null) die('Not confirmed, nothing deleted.');
  if (answer.trim() !== 'yes') {
    console.log('Nothing was deleted.');
    return;
  }
  rmSync(devDir, { recursive: true, force: true });
  console.log(`Deleted ${folder}/`);
}

// ---------------------------------------------------------------------------
// h. Start
// ---------------------------------------------------------------------------

function start(devDir, stopWatcher) {
  // setup-dev.js pre-builds the dev pieces it finds in AP_DEV_PIECES, and an exported value beats
  // .env.dev there, while turbo strips it before the server reads it. Setting it here keeps the
  // two in step whatever the shell exports.
  const child = spawn('npm', ['start'], {
    cwd: devDir,
    stdio: 'inherit',
    env: { ...process.env, AP_DEV_PIECES: PIECE_FOLDER },
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopWatcher();
    child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('exit', (code, signal) => {
    stopWatcher();
    // A signal leaves no exit code. 128 + its number is what a shell reports, and it keeps a server
    // killed from outside, out of memory for one, from looking like a clean stop.
    process.exit(signal ? 128 + (osConstants.signals[signal] ?? 0) : code);
  });
}

// ---------------------------------------------------------------------------
// i. Checkout
// ---------------------------------------------------------------------------

/** Upstream at .ap-pin in .ap-dev/: a blobless clone, never moved once it is there. */
function prepareDefault(devDir, pin) {
  if (existsSync(devDir)) {
    if (!existsSync(join(devDir, '.git'))) {
      die(`.ap-dev exists but is not a git checkout. Delete it and run again:\n  rm -rf ${devDir}`);
    }
    const head = readHead(devDir, DEFAULT_FOLDER);
    if (head !== pin) {
      die(
        `.ap-dev is at ${head}, but .ap-pin says ${pin}.\n` +
          'It is not moved automatically. Delete it and run again, and it is cloned at the new pin:\n' +
          `  npm run dev:ap -- --reset\nor\n  rm -rf ${devDir}\n` +
          'That loses the dev database with the flows and connections made in it. .env.dev.local at ' +
          'the repository root is kept.'
      );
    }
    console.log('.ap-dev: reusing the existing checkout.');
    return { head };
  }
  console.log(
    '.ap-dev: first run, cloning Activepieces. Expect 1 to 15 minutes depending on the network, ' +
      'and about 3 GB once installed.'
  );
  const started = Date.now();
  run('git', ['clone', '--filter=blob:none', UPSTREAM, devDir]);
  run('git', ['-C', devDir, 'checkout', '--quiet', pin]);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`.ap-dev: cloned in ${seconds}s. The install below adds roughly 2.5 GB more.`);
  return { head: pin };
}

/**
 * Any other source: one shallow fetch of the ref, then reused as it is. A branch is not followed,
 * since nothing moves it here; the marker records what was fetched.
 */
function prepareSource(source, devDir) {
  const { folder, repo, ref } = source;
  if (existsSync(devDir)) {
    const marker = readMarker(devDir);
    // The marker is written last, after the fetch. A folder without it, and without an install,
    // is one an interrupted first run left behind: nothing in it is worth keeping.
    if (!marker && !existsSync(join(devDir, 'node_modules'))) {
      console.log(`${folder}: an earlier fetch did not finish. Deleting it and fetching again.`);
      rmSync(devDir, { recursive: true, force: true });
    }
  }
  if (existsSync(devDir)) {
    if (!existsSync(join(devDir, '.git'))) {
      die(`${folder} exists but is not a git checkout. Delete it and run again:\n  rm -rf ${devDir}`);
    }
    const marker = readMarker(devDir);
    if (!marker || marker.repo !== repo || marker.ref !== ref) {
      die(
        `${folder} has no record of fetching ${describeSource(repo, ref)} (${MARKER_FILE}), so it ` +
          'is not reused. Delete it and run again:\n  npm run dev:ap -- --reset'
      );
    }
    const head = readHead(devDir, folder);
    console.log(
      `${folder}: reusing the checkout of ${ref} at ${marker.commit}, without fetching. For newer ` +
        'commits on a branch, delete it with --reset and run again.'
    );
    if (head !== marker.commit) console.warn(`Warning: ${folder} has since been moved to ${head}.`);
    return { head };
  }

  console.log(`${folder}: first run for this source, fetching ${ref} (depth 1).`);
  mkdirSync(devDir);
  try {
    run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', devDir]);
    // "--" so that neither value can be read as a git option; resolveSource refuses a leading "-"
    // as well, so this is the second line of defence.
    run('git', ['-C', devDir, 'remote', 'add', 'origin', '--', repo]);
    // No terminal prompt: git uses the credentials it already has (an SSH key or a credential
    // helper) or fails, and this script never asks for a token or keeps one.
    run('git', ['-C', devDir, 'fetch', '--depth', '1', 'origin', '--', ref], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    run('git', ['-C', devDir, 'checkout', '--quiet', 'FETCH_HEAD']);
  } catch (error) {
    rmSync(devDir, { recursive: true, force: true });
    die(
      `Could not fetch ${ref} from ${repo}: ${error.message}\n` +
        `Check that \`git ls-remote ${repo}\` works in this shell. A private repository needs your ` +
        'own access, through an SSH key or a git credential helper. A commit has to be the full ' +
        '40-character sha.'
    );
  }
  const commit = capture('git', ['-C', devDir, 'rev-parse', 'HEAD']);
  writeJson(join(devDir, MARKER_FILE), { repo, ref, commit });
  console.log(
    `${folder}: fetched ${ref}${ref === commit ? '' : ` at ${commit}`}. The install below adds ` +
      'roughly 2.5 GB.'
  );
  return { head: commit };
}

/**
 * Only tracked paths under packages/pieces, which is where Activepieces looks and where an old fork
 * branch carries the piece (for example in packages/pieces/community/orocommerce). The copy itself
 * always goes to packages/pieces/custom. The checkout is kept: deleting it would only make the next
 * run fetch it again and hit the same refusal.
 */
function checkStrayPieces(devDir, folder, isDefault) {
  const listed = spawnSync(
    'git',
    ['-C', devDir, 'ls-files', '-z', '--', `:(glob)${PIECES_ROOT}/**/${PIECE_FOLDER}/package.json`],
    { encoding: 'utf8' }
  );
  if (listed.status !== 0) die(`git ls-files failed in ${folder}: ${listed.stderr.trim()}`);
  const stray = strayPieceFolders(
    listed.stdout.split('\0'),
    PIECE_FOLDER,
    DEV_PIECE_SEGMENTS.join('/'),
    PIECES_ROOT
  );
  if (stray.length === 0) return;
  die(
    `${folder} already has a piece folder named ${PIECE_FOLDER}:\n` +
      stray.map((path) => `  ${folder}/${path}`).join('\n') +
      '\nActivepieces finds dev pieces by folder name, so it could build or serve that one instead ' +
      `of the copy in ${DEV_PIECE_SEGMENTS.join('/')}.\n` +
      (isDefault
        ? 'This is upstream at .ap-pin, so the pin itself carries that folder. Move .ap-pin to a ' +
          'commit without it, or set DEV_AP_REF in .env.dev.local to one meanwhile.'
        : `Use a ref without it. To delete ${folder}: npm run dev:ap -- --reset`)
  );
}

async function main() {
  if (unknownArgs.length > 0) {
    die(
      `Unknown option: ${unknownArgs.join(' ')}\n` +
        `Valid flags: ${VALID_FLAGS.join(', ')}. Run with no flags to start Activepieces.`
    );
  }

  const pin = readPin();
  let local = [];
  let source;
  try {
    local = readLocalEnv();
    source = resolveSource(local, UPSTREAM, pin);
  } catch (error) {
    // --reset is how a developer recovers, so a .env.dev.local it cannot read must not stop it.
    // Without a source there is no folder to pick, so it offers the default one.
    if (!doReset) throw error;
    console.warn(`Warning: ${error.message}\n--reset goes on with ${DEFAULT_FOLDER}/ regardless.`);
    source = { isDefault: true, repo: UPSTREAM, ref: null, folder: DEFAULT_FOLDER };
  }
  const devDir = join(REPO_ROOT, source.folder);
  const sourceName = source.isDefault
    ? 'upstream Activepieces at .ap-pin'
    : describeSource(source.repo, source.ref);
  console.log(`Source: ${sourceName}, in ${source.folder}/`);

  if (doReset) {
    await reset(source.folder, devDir);
    return;
  }

  checkNode();
  checkBun();
  checkDeno();
  await checkPorts();

  console.log(`Activepieces pin: ${pin}`);

  const { head } = source.isDefault ? prepareDefault(devDir, pin) : prepareSource(source, devDir);
  if (head !== pin) {
    console.warn(
      `Warning: ${source.folder} is at ${head}, not at .ap-pin. The Node and bun checks above and ` +
        'the piece itself are only proven against the pin.'
    );
  }
  checkStrayPieces(devDir, source.folder, source.isDefault);

  const copyDir = join(devDir, DEV_PIECE_PATH);
  const isNewCopy = copyPiece(copyDir);
  console.log(`Piece copied into ${relative(REPO_ROOT, copyDir)}${isNewCopy ? ' (new)' : ''}.`);

  writeEnvDev(devDir, local);

  // bun has to re-read the workspace once the new member exists; after that the links persist.
  // The root check also covers a half-finished or hand-deleted install.
  const needsInstall =
    isNewCopy ||
    !existsSync(join(copyDir, 'node_modules')) ||
    !existsSync(join(devDir, 'node_modules'));
  if (needsInstall) {
    console.log('Running bun install so the new workspace member is linked...');
    runWithRetry('bun', ['install'], { cwd: devDir });
  }

  const stopWatcher = startWatcher(copyDir);
  console.log(`env: ${relative(REPO_ROOT, join(devDir, '.env.dev'))}`);
  console.log('\nStarting Activepieces. Sign in at http://localhost:4200 as dev@ap.com / 12345678.\n');
  start(devDir, stopWatcher);
}

main().catch((error) => die(error.message));
