#!/usr/bin/env node
/**
 * Bundle the piece with the official Activepieces CLI and pack the result.
 *
 * The CLI resolves @activepieces/* through the workspace aliases of the repository it finds by
 * walking up from the piece for a package.json with a workspaces array. That repository has to be
 * the fetched upstream tree, so the piece is staged into it at packages/pieces/community/orocommerce
 * - the path its workspaces array already covers - bundled there, and the output copied back.
 *
 * Only package.json and src/ are staged. The tests, the tooling and the tsconfig files are not
 * inputs to the bundle, and staging them would put fork-relative "extends" paths into a tree where
 * they do not resolve.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, SRC_DIR, fetchUpstream } from './fetch-ap.mjs';

const PIECE_DIR = join(REPO_ROOT, 'packages', 'orocommerce');
const STAGED_DIR = join(SRC_DIR, 'packages', 'pieces', 'community', 'orocommerce');
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');
const CLI_ENTRY = join(REPO_ROOT, 'node_modules', '@activepieces', 'cli', 'index.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout.trim();
}

export function bundle() {
  fetchUpstream();

  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`@activepieces/cli is not installed (${CLI_ENTRY} is missing). Run npm ci first.`);
  }

  console.log('Staging the piece into the fetched tree');
  rmSync(STAGED_DIR, { recursive: true, force: true });
  mkdirSync(STAGED_DIR, { recursive: true });
  cpSync(join(PIECE_DIR, 'package.json'), join(STAGED_DIR, 'package.json'));
  cpSync(join(PIECE_DIR, 'src'), join(STAGED_DIR, 'src'), { recursive: true });
  // The bundler writes into dist but will not create it.
  mkdirSync(join(STAGED_DIR, 'dist'), { recursive: true });

  console.log('Bundling');
  // Invoked as its JS entry, from the repository root, so the CLI and everything it pulls in
  // resolve against the root node_modules rather than anything inside the sparse tree.
  run(process.execPath, [CLI_ENTRY, 'pieces', 'bundle', STAGED_DIR], { cwd: REPO_ROOT });

  const builtDist = join(STAGED_DIR, 'dist');
  const indexFile = join(builtDist, 'src', 'index.js');
  if (!existsSync(indexFile)) {
    throw new Error(`The bundler produced no ${indexFile}.`);
  }

  console.log('Copying dist back');
  const localDist = join(PIECE_DIR, 'dist');
  rmSync(localDist, { recursive: true, force: true });
  cpSync(builtDist, localDist, { recursive: true });

  console.log('Packing');
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  // Packed from the built dist, which is the package that gets published: its package.json is the
  // one the bundler rewrote, with the workspace dependencies resolved away.
  const packed = capture('npm', ['pack', '--pack-destination', ARTIFACTS_DIR, '--silent'], {
    cwd: localDist,
  });
  const tarball = join(ARTIFACTS_DIR, packed.split('\n').pop().trim());
  if (!existsSync(tarball)) {
    throw new Error(`npm pack reported ${tarball}, which does not exist.`);
  }

  const manifest = JSON.parse(readFileSync(join(localDist, 'package.json'), 'utf8'));
  console.log(`\nPacked ${manifest.name}@${manifest.version}`);
  console.log(`  ${tarball}`);
  return tarball;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    bundle();
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
