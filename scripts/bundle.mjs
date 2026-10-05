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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, SRC_DIR, fetchUpstream, readPin } from './fetch-ap.mjs';
import { bundledPackages, buildNotice } from './notices.mjs';

const PIECE_DIR = join(REPO_ROOT, 'packages', 'orocommerce');
const STAGED_DIR = join(SRC_DIR, 'packages', 'pieces', 'community', 'orocommerce');
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');
const CLI_ENTRY = join(REPO_ROOT, 'node_modules', '@activepieces', 'cli', 'index.js');
const METAFILE_HOOK = join(REPO_ROOT, 'scripts', 'esbuild-metafile.cjs');
const LICENCE_FILE = join(REPO_ROOT, 'LICENSE');
const README_FILE = join(PIECE_DIR, 'README.md');

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

/** The copyright line out of LICENSE, so the notice never states a different one. */
function licenceCopyright() {
  const licence = readFileSync(LICENCE_FILE, 'utf8');
  const line = licence.split('\n').find((entry) => entry.startsWith('Copyright '));
  if (!line) {
    throw new Error(`No copyright line in ${LICENCE_FILE}.`);
  }
  return line.trim();
}

export function bundle() {
  fetchUpstream();

  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`@activepieces/cli is not installed (${CLI_ENTRY} is missing). Run npm ci first.`);
  }

  // Emptied once, here, rather than just before packing: the metafile is written into it during
  // the bundle, and verify-artifact expects to find exactly one .tgz.
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  console.log('Staging the piece into the fetched tree');
  rmSync(STAGED_DIR, { recursive: true, force: true });
  mkdirSync(STAGED_DIR, { recursive: true });
  cpSync(join(PIECE_DIR, 'package.json'), join(STAGED_DIR, 'package.json'));
  cpSync(join(PIECE_DIR, 'src'), join(STAGED_DIR, 'src'), { recursive: true });
  // The bundler writes into dist but will not create it.
  mkdirSync(join(STAGED_DIR, 'dist'), { recursive: true });

  console.log('Bundling');
  // Invoked as its JS entry, from the repository root, so the CLI and everything it pulls in
  // resolve against the root node_modules rather than anything inside the sparse tree. The
  // preload writes out the bundler's metafile, which is the only accurate account of what ends up
  // in the artifact and so the only sound basis for the notice file.
  const metafilePath = join(ARTIFACTS_DIR, 'bundle-metafile.json');
  run(process.execPath, ['--require', METAFILE_HOOK, CLI_ENTRY, 'pieces', 'bundle', STAGED_DIR], {
    cwd: REPO_ROOT,
    env: { ...process.env, AP_METAFILE_OUT: metafilePath },
  });

  const builtDist = join(STAGED_DIR, 'dist');
  const indexFile = join(builtDist, 'src', 'index.js');
  if (!existsSync(indexFile)) {
    throw new Error(`The bundler produced no ${indexFile}.`);
  }
  if (!existsSync(metafilePath)) {
    throw new Error(
      `The bundler wrote no metafile to ${metafilePath}. scripts/esbuild-metafile.cjs has to ` +
        `wrap esbuild.build for the notice file to be generated; check it still matches the CLI.`,
    );
  }

  console.log('Copying dist back');
  const localDist = join(PIECE_DIR, 'dist');
  rmSync(localDist, { recursive: true, force: true });
  cpSync(builtDist, localDist, { recursive: true });

  forceTlsVerification(join(localDist, 'src', 'index.js'));
  removeFailedRequestLog(join(localDist, 'src', 'index.js'));

  console.log('Writing README, LICENSE and NOTICE into the package');
  // README, LICENSE and NOTICE ship; other docs stay out because only what is copied into dist is
  // packed.
  const packages = bundledPackages(JSON.parse(readFileSync(metafilePath, 'utf8')));
  const manifest = JSON.parse(readFileSync(join(localDist, 'package.json'), 'utf8'));
  const notice = buildNotice({
    packages,
    pin: readPin(),
    pieceName: manifest.name,
    copyright: licenceCopyright(),
  });
  cpSync(README_FILE, join(localDist, 'README.md'));
  cpSync(LICENCE_FILE, join(localDist, 'LICENSE'));
  writeFileSync(join(localDist, 'NOTICE'), notice);
  // The bundler rewrites the manifest with a files allow-list. npm force-includes README.md and
  // LICENSE whatever that list says, but not NOTICE, so all three are listed here.
  if (Array.isArray(manifest.files) && !manifest.files.includes('NOTICE')) {
    manifest.files = [...manifest.files, 'README.md', 'LICENSE', 'NOTICE'];
    writeFileSync(join(localDist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFileSync(
    join(ARTIFACTS_DIR, 'bundled-packages.json'),
    `${JSON.stringify(packages.map(({ name, version, licence }) => ({ name, version, licence })), null, 2)}\n`,
  );
  console.log(`  ${packages.length} bundled npm packages listed in NOTICE`);

  console.log('Packing');
  // Packed from the built dist, which is the package that gets published: its package.json is the
  // one the bundler rewrote, with the workspace dependencies resolved away.
  const packed = capture('npm', ['pack', '--pack-destination', ARTIFACTS_DIR, '--silent'], {
    cwd: localDist,
  });
  const tarball = join(ARTIFACTS_DIR, packed.split('\n').pop().trim());
  if (!existsSync(tarball)) {
    throw new Error(`npm pack reported ${tarball}, which does not exist.`);
  }

  console.log(`\nPacked ${manifest.name}@${manifest.version}`);
  console.log(`  ${tarball}`);
  return tarball;
}

/**
 * Take upstream's blanket certificate opt-out out of the artifact.
 *
 * FetchHttpClient.sendRequest opens by setting NODE_TLS_REJECT_UNAUTHORIZED to '0', which turns off
 * certificate verification for every request it makes - and, because the variable is process-wide
 * and pieces share a worker, for everything running next to it too. The piece bundles that client,
 * so the assignment ends up in what we publish.
 *
 * It cannot be fixed in .ap-src: that tree has to stay byte-identical to the pinned commit, which
 * ap:check-clean enforces. So it is cut out of the built bundle instead, here, where the edit is
 * visible in the build rather than hidden in a checkout.
 *
 * The count has to be exactly one. Zero means upstream moved or reworded it and this no longer does
 * anything - which would ship the opt-out again, silently, so the build stops instead. More than one
 * means there is a second site to think about before removing anything.
 */
function forceTlsVerification(indexFile) {
  const ASSIGNMENT =
    /process\.env(?:\.NODE_TLS_REJECT_UNAUTHORIZED|\[(["'])NODE_TLS_REJECT_UNAUTHORIZED\1\])\s*=\s*(["'])0\2\s*;/g;
  const source = readFileSync(indexFile, 'utf8');
  const found = source.match(ASSIGNMENT) ?? [];

  if (found.length !== 1) {
    throw new Error(
      `Expected exactly one NODE_TLS_REJECT_UNAUTHORIZED assignment in ${indexFile}, found ${found.length}. ` +
        'Upstream changed how it disables certificate verification. Re-read ' +
        'packages/pieces/common/src/lib/http/core/fetch-http-client.ts at the pinned commit and update ' +
        'forceTlsVerification in scripts/bundle.mjs before releasing.',
    );
  }

  const patched = source.replace(ASSIGNMENT, '');
  if (patched.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
    throw new Error(
      `${indexFile} still mentions NODE_TLS_REJECT_UNAUTHORIZED after the assignment was removed. ` +
        'Something else in the bundle touches it; check before releasing.',
    );
  }

  writeFileSync(indexFile, patched);
  console.log('Removed the bundled NODE_TLS_REJECT_UNAUTHORIZED opt-out (1 occurrence)');
}

/**
 * Take upstream's log of every failed request out of the artifact.
 *
 * FetchHttpClient.sendRequest prints the HttpError to stderr before throwing it, and that error
 * carries the request body: on a failed token request the client id and secret, on any other failed
 * call the record being sent. The engine's stderr ends up in the worker's log. The error is thrown
 * either way, so the caller still sees it; only the print goes. In its place the piece logs a short
 * line of its own, with the method, address and status only, from
 * packages/orocommerce/src/lib/common/request-log.ts.
 *
 * Like the TLS opt-out it cannot be changed in .ap-src, so it is cut from the built bundle. The
 * minifier folds the call into the throw (`throw console.error(...),error`), which makes it an
 * expression, not a statement, so it is replaced with `void 0` rather than deleted: an expression in
 * place of an expression is valid wherever the call sits.
 *
 * The count has to be exactly one, for the same reasons as above: zero means upstream reworded or
 * moved it and the secret would be printed again, more than one means a second site to look at.
 */
function removeFailedRequestLog(indexFile) {
  const LOG_CALL =
    /console\.error\(\s*(["'`])\[HttpClient#\(sanitized error message\)\] Request failed:\1\s*,\s*[A-Za-z_$][\w$]*\s*\)/g;
  const source = readFileSync(indexFile, 'utf8');
  const found = source.match(LOG_CALL) ?? [];

  if (found.length !== 1) {
    throw new Error(
      `Expected exactly one failed-request console.error in ${indexFile}, found ${found.length}. ` +
        'Upstream changed how it logs failed requests. Re-read ' +
        'packages/pieces/common/src/lib/http/core/fetch-http-client.ts at the pinned commit and update ' +
        'removeFailedRequestLog in scripts/bundle.mjs before releasing.',
    );
  }

  const patched = source.replace(LOG_CALL, 'void 0');
  if (patched.includes('[HttpClient#')) {
    throw new Error(
      `${indexFile} still mentions [HttpClient# after the failed-request log was removed. ` +
        'Something else in the bundle logs from the HTTP client; check before releasing.',
    );
  }

  writeFileSync(indexFile, patched);
  console.log('Removed the bundled failed-request log (1 occurrence)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    bundle();
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
