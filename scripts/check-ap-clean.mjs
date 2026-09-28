#!/usr/bin/env node
/**
 * Assert that the fetched upstream tree is exactly what upstream published.
 *
 * The bundle inlines the framework and the common package, so whatever is in .ap-src ends up inside
 * the artifact. If anything in this repository edited that tree - a patch applied to work around an
 * upstream bug, a stray write from a script, a half-cleaned staging directory left by an interrupted
 * build - the piece would ship code that does not exist at the pinned commit, and nothing in the diff
 * of this repository would say so. A cached tree makes it worse: the edit would survive across runs.
 *
 * The one permitted difference is the piece itself, which scripts/bundle.mjs copies to
 * packages/pieces/community/orocommerce so the CLI can resolve the workspace. Nothing else may differ.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(REPO_ROOT, '.ap-src');
const PIN_FILE = join(REPO_ROOT, '.ap-pin');

/** The path bundle.mjs stages the piece into; the only entry allowed to appear. */
const STAGED_PIECE = 'packages/pieces/community/orocommerce';

function git(args) {
  const result = spawnSync('git', args, { cwd: SRC_DIR, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function main() {
  if (!existsSync(join(SRC_DIR, '.git'))) {
    console.error('No checkout at .ap-src. Run npm run ap:fetch first.');
    process.exit(1);
  }

  const pin = readFileSync(PIN_FILE, 'utf8').trim();
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== pin) {
    console.error(`.ap-src is at ${head}, but .ap-pin says ${pin}.`);
    console.error('Re-fetch with: npm run ap:fetch -- --force');
    process.exit(1);
  }

  // --porcelain reports only what differs from the commit. In a cone sparse checkout that is the
  // four packages and the root files, which is exactly the part the bundle reads.
  const entries = git(['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    // Each line is "XY path". Renames and quoted paths do not occur here: nothing renames files in
    // this tree, and upstream has no paths needing quoting.
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
    .filter((entry) => entry.path !== STAGED_PIECE && !entry.path.startsWith(`${STAGED_PIECE}/`));

  if (entries.length > 0) {
    console.error('The fetched upstream tree has been modified:\n');
    for (const entry of entries) console.error(`  ${entry.status.padEnd(2)} ${entry.path}`);
    console.error(
      `\n${entries.length} unexpected change(s). The tree must stay exactly as upstream published it: ` +
        'whatever is in it is inlined into the artifact. Delete .ap-src and re-fetch, and if a script ' +
        'in this repository wrote there, fix the script rather than this check.'
    );
    process.exit(1);
  }

  console.log(`.ap-src is unmodified at ${head}.`);
}

try {
  main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
