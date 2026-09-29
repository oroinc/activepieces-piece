#!/usr/bin/env node
/**
 * Check a packed .tgz before it is ever handed to anyone.
 *
 * The point of the load check is that the bundle is self-contained: the piece ships as one file and
 * Activepieces loads it with no install step, so the artifact is extracted somewhere with no
 * node_modules in any ancestor directory and required there. If anything survived as a bare import,
 * the require throws instead of quietly resolving against this repository's node_modules.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');

const BUNDLED_PACKAGES = join(ARTIFACTS_DIR, 'bundled-packages.json');

const EXPECTED_NAME = '@oroinc/piece-orocommerce';
const EXPECTED_MAIN = './src/index.js';
const EXPECTED_ACTIONS = 11;
const EXPECTED_TRIGGERS = ['oro-webhook-event'];
const MIN_BYTES = 20 * 1024; // the real artifact is ~65-130 KB; 1 KB would be an empty shell

const failures = [];
const notes = [];

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function findTarball() {
  const fromArgv = process.argv[2];
  if (fromArgv) return resolve(fromArgv);
  if (!existsSync(ARTIFACTS_DIR)) {
    throw new Error('No artifacts/ directory. Run npm run bundle first, or pass a path.');
  }
  const candidates = readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith('.tgz'));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one .tgz in artifacts/, found ${candidates.length}.`);
  }
  return join(ARTIFACTS_DIR, candidates[0]);
}

/** Refuse to run the load check anywhere a stray node_modules could mask a bare import. */
function assertNoNodeModulesAbove(dir) {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, 'node_modules'))) {
      throw new Error(`${current} has a node_modules; the load check would not prove anything there.`);
    }
    const next = dirname(current);
    if (next === current || current === parse(current).root) return;
    current = next;
  }
}

/**
 * The notice is only worth shipping if it is complete. bundle.mjs records the packages the
 * bundler reported as contributing code; every one of them has to appear in the notice with the
 * version that was bundled, so a package added by a pin bump cannot ship unattributed.
 */
function checkNoticeNamesEveryBundledPackage(notice) {
  if (!existsSync(BUNDLED_PACKAGES)) {
    check('NOTICE names every bundled package', false, `no ${BUNDLED_PACKAGES}; run npm run bundle`);
    return;
  }
  const expected = JSON.parse(readFileSync(BUNDLED_PACKAGES, 'utf8'));
  if (expected.length === 0) {
    check('NOTICE names every bundled package', false, 'the bundled package list is empty');
    return;
  }
  const missing = expected.filter((pkg) => !notice.includes(`${pkg.name}@${pkg.version}`));
  check(
    'NOTICE names every bundled package',
    missing.length === 0,
    missing.length === 0
      ? `${expected.length} packages`
      : `missing ${missing.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`
  );
}

function main() {
  const tarball = findTarball();
  console.log(`Verifying ${tarball}\n`);

  const size = statSync(tarball).size;
  check('size is well above 1 KB', size >= MIN_BYTES, `${size} bytes`);

  const sandbox = mkdtempSync(join(tmpdir(), 'oro-piece-verify-'));
  try {
    assertNoNodeModulesAbove(sandbox);
    const untar = spawnSync('tar', ['xzf', tarball, '-C', sandbox], { encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);

    const pkgDir = join(sandbox, 'package');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

    check('package.json name', manifest.name === EXPECTED_NAME, manifest.name);
    check('package.json version is set', /^\d+\.\d+\.\d+/.test(manifest.version ?? ''), manifest.version);
    check('package.json main', manifest.main === EXPECTED_MAIN, manifest.main);
    check(
      'dependencies is empty',
      manifest.dependencies && Object.keys(manifest.dependencies).length === 0,
      JSON.stringify(manifest.dependencies)
    );

    // The README is the npm page: without it npmjs.com shows the package with no description at
    // all, which is how the first v1.0.0 build was packed.
    check('README.md ships in the package', existsSync(join(pkgDir, 'README.md')));

    // The repository's other documents - the changelog, the architecture notes, whatever gets
    // written next to them later - are for people working in this repository, not for anyone
    // installing the package, and they are what Oro's other published packages keep out with an
    // .npmignore. Here the manifest's files list is an allow-list and the package is packed from
    // dist, so they stay out by not being copied there. Checked as a rule rather than by name,
    // because the risk is a document nobody thought to list: bundle.mjs copies README.md out of a
    // directory that holds the others, and a copy widened to that directory would sweep them in.
    const strayDocs = readdirSync(pkgDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    check(
      'no document other than README.md ships',
      strayDocs.length === 0,
      strayDocs.join(', ') || 'none'
    );

    // Most of the artifact is other people's code, inlined. Both files are written by
    // scripts/bundle.mjs into the directory npm packs; npm force-includes LICENSE but drops
    // anything else missing from the manifest's files list, so NOTICE is checked here rather than
    // trusted to have survived the pack.
    check('LICENSE ships in the package', existsSync(join(pkgDir, 'LICENSE')));
    const noticePath = join(pkgDir, 'NOTICE');
    check('NOTICE ships in the package', existsSync(noticePath));
    if (existsSync(noticePath)) {
      checkNoticeNamesEveryBundledPackage(readFileSync(noticePath, 'utf8'));
    }

    const entry = join(pkgDir, 'src', 'index.js');
    check('src/index.js exists', existsSync(entry));
    if (!existsSync(entry)) return;

    // Loaded in a child process so a failure here is a clean exit code, not a half-initialised
    // module in this one. Bare requires are recorded rather than merely allowed to throw, so the
    // report names the offending specifier.
    const probe = `
      const Module = require('node:module');
      const path = require('node:path');
      const bare = [];
      const load = Module._load;
      Module._load = function (request, parent, isMain) {
        const relative = request.startsWith('.') || path.isAbsolute(request);
        if (!relative && !Module.builtinModules.includes(request.replace(/^node:/, ''))) {
          bare.push(request);
        }
        return load.apply(this, arguments);
      };
      const loaded = require(${JSON.stringify(entry)});
      const keys = Object.keys(loaded);
      const piece = loaded[keys[0]];
      // actions()/triggers() are accessors on the prototype; _actions/_triggers are the maps
      // behind them. Prefer the public ones and fall back, so a change to either shape is caught
      // rather than silently reported as zero.
      const asMap = (value) => (typeof value === 'function' ? value.call(piece) : value) || {};
      const actions = asMap(piece.actions) ;
      const triggers = asMap(piece.triggers);
      const out = {
        exportKeys: keys,
        constructorName: piece && piece.constructor && piece.constructor.name,
        isObject: piece !== null && typeof piece === 'object',
        actionCount: Object.keys(actions).length,
        actionNames: Object.keys(actions),
        triggerNames: Object.keys(triggers),
        displayName: piece.displayName,
        minimumSupportedRelease: piece.minimumSupportedRelease,
        authType: piece.auth && piece.auth.type,
        bareRequires: bare,
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['-e', probe], { cwd: sandbox, encoding: 'utf8' });
    if (result.status !== 0) {
      check('src/index.js loads with no node_modules nearby', false, result.stderr.trim().split('\n')[0]);
      return;
    }
    const loaded = JSON.parse(result.stdout);

    check('loads with no node_modules nearby', true, `exports ${loaded.exportKeys.join(', ')}`);
    check('export is an object', loaded.isObject === true);
    check("constructor.name is 'Piece'", loaded.constructorName === 'Piece', loaded.constructorName);
    check('no bare requires survived bundling', loaded.bareRequires.length === 0, loaded.bareRequires.join(', ') || 'none');
    check(`${EXPECTED_ACTIONS} actions`, loaded.actionCount === EXPECTED_ACTIONS, String(loaded.actionCount));
    check(
      `1 trigger (${EXPECTED_TRIGGERS.join(', ')})`,
      loaded.triggerNames.length === EXPECTED_TRIGGERS.length &&
        EXPECTED_TRIGGERS.every((t) => loaded.triggerNames.includes(t)),
      loaded.triggerNames.join(', ')
    );

    notes.push(
      `displayName ${loaded.displayName}, minimumSupportedRelease ${loaded.minimumSupportedRelease}, auth ${loaded.authType}`
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  for (const note of notes) console.log(`\n      ${note}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

try {
  main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
