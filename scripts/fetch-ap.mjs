#!/usr/bin/env node
/**
 * Fetch the slice of activepieces/activepieces the piece needs in order to build.
 *
 * The published @activepieces/pieces-framework on npm lags the engine by a long way, so the
 * framework has to come from source. A full clone is ~2.7 GB; the bundler only ever reaches four
 * packages, so this takes a sparse, blobless checkout of exactly those, at the commit in .ap-pin.
 *
 * The checkout lands in .ap-src/ (git-ignored). node_modules deliberately stays at the repository
 * root, outside that tree: esbuild resolves by walking up from each importing file, so the fetched
 * sources find the root node_modules on their own, and nothing has to be installed inside .ap-src.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join(REPO_ROOT, '.ap-pin');
const SRC_DIR = join(REPO_ROOT, '.ap-src');
const STAMP_FILE = join(SRC_DIR, '.ap-pin-stamp');
const UPSTREAM = 'https://github.com/activepieces/activepieces.git';

/** The only paths the bundler and the tests reach. Cone mode adds the root-level files for free. */
export const SPARSE_PATHS = [
  'packages/pieces/framework',
  'packages/pieces/common',
  'packages/core/utils',
  'packages/core/piece-types',
];

export function readPin() {
  if (!existsSync(PIN_FILE)) {
    throw new Error('.ap-pin is missing.');
  }
  const pin = readFileSync(PIN_FILE, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) {
    throw new Error(
      `.ap-pin must hold one full 40-character lowercase commit sha, got: ${JSON.stringify(pin)}.\n` +
        'A tag, a branch or a version string will not do: upstream reuses version strings across ' +
        'trees, so only a sha names one tree.'
    );
  }
  return pin;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

export function currentStamp() {
  return existsSync(STAMP_FILE) ? readFileSync(STAMP_FILE, 'utf8').trim() : null;
}

export function fetchUpstream({ force = false } = {}) {
  const pin = readPin();

  if (!force && currentStamp() === pin) {
    console.log(`.ap-src already at ${pin}, nothing to fetch.`);
    return { dir: SRC_DIR, pin, fetched: false };
  }

  rmSync(SRC_DIR, { recursive: true, force: true });
  mkdirSync(SRC_DIR, { recursive: true });

  console.log(`Fetching activepieces at ${pin} into .ap-src (sparse, blobless)`);
  git(['init', '-q'], SRC_DIR);
  git(['remote', 'add', 'origin', UPSTREAM], SRC_DIR);
  git(['sparse-checkout', 'init', '--cone'], SRC_DIR);
  git(['sparse-checkout', 'set', ...SPARSE_PATHS], SRC_DIR);
  // --filter=blob:none keeps history metadata out of the transfer; --depth 1 keeps it to one commit.
  git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', pin], SRC_DIR);
  git(['checkout', '-q', 'FETCH_HEAD'], SRC_DIR);

  for (const path of SPARSE_PATHS) {
    if (!existsSync(join(SRC_DIR, path))) {
      throw new Error(`${path} is missing from the checkout at ${pin}.`);
    }
  }
  // The bundler finds the repo root by walking up for a package.json with a workspaces array.
  // Cone mode brings that root manifest along; without it the staged piece cannot resolve
  // @activepieces/* at all.
  const rootManifest = join(SRC_DIR, 'package.json');
  if (!existsSync(rootManifest)) {
    throw new Error('The checkout has no root package.json, so workspace resolution would fail.');
  }
  const workspaces = JSON.parse(readFileSync(rootManifest, 'utf8')).workspaces;
  if (!Array.isArray(workspaces) || !workspaces.includes('packages/pieces/community/*')) {
    throw new Error(
      'The root package.json does not list packages/pieces/community/* in workspaces, so the ' +
        'staged piece would not resolve.'
    );
  }

  writeFileSync(STAMP_FILE, `${pin}\n`);
  console.log(`.ap-src ready at ${pin}`);
  return { dir: SRC_DIR, pin, fetched: true };
}

export { REPO_ROOT, SRC_DIR };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    fetchUpstream({ force: process.argv.includes('--force') });
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
