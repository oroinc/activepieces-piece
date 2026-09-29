#!/usr/bin/env node
/**
 * Write the release notes for a packed artifact, and the same facts as JSON for the workflow.
 *
 * A release of this piece is not the diff of this repository. Most of what ships in the artifact is
 * inlined from the Activepieces tree at the pinned commit, so "which commit of this repository" does
 * not by itself say what somebody downloaded. The notes therefore record four things together - the
 * tag's commit, the pin, the hash of the tarball and the hash of the single bundled file inside it -
 * and that set is what makes a published version identifiable after the fact.
 *
 * Both hashes are recorded because they answer different questions. The tarball hash is what a
 * download is checked against. The hash of package/src/index.js stays true when the artifact is
 * repackaged, which is what npm does to a published version, and it covers the one file
 * Activepieces loads.
 *
 *   node scripts/release-notes.mjs --tag v1.0.0 --commit <sha>
 *   node scripts/release-notes.mjs                 # dry run, no tag
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');
const PIN_FILE = join(REPO_ROOT, '.ap-pin');
const BUNDLE_PATH = 'package/src/index.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function findTarball() {
  const fromArgv = arg('tarball');
  if (fromArgv) return resolve(fromArgv);
  if (!existsSync(ARTIFACTS_DIR)) {
    throw new Error('No artifacts/ directory. Run npm run bundle first.');
  }
  const candidates = readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith('.tgz'));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one .tgz in artifacts/, found ${candidates.length}.`);
  }
  return join(ARTIFACTS_DIR, candidates[0]);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Read one member out of the tarball without unpacking it anywhere. */
function readFromTarball(tarball, member) {
  const result = spawnSync('tar', ['-xzOf', tarball, member], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`tar could not read ${member} from ${basename(tarball)}: ${result.stderr}`);
  }
  if (result.stdout.length === 0) {
    throw new Error(`${member} is empty in ${basename(tarball)}.`);
  }
  return result.stdout;
}

function manifestFromTarball(tarball) {
  return JSON.parse(readFromTarball(tarball, 'package/package.json').toString('utf8'));
}

function main() {
  const tarball = findTarball();
  const tag = arg('tag');
  const commit = arg('commit') ?? process.env.GITHUB_SHA ?? null;
  const pin = readFileSync(PIN_FILE, 'utf8').trim();
  const manifest = manifestFromTarball(tarball);

  const identity = {
    name: manifest.name,
    version: manifest.version,
    tag,
    commit,
    pin,
    tarball: basename(tarball),
    tarballSha256: sha256(readFileSync(tarball)),
    bundleSha256: sha256(readFromTarball(tarball, BUNDLE_PATH)),
  };

  const rows = [
    ['Tag', identity.tag ? `\`${identity.tag}\`` : 'none - this is a dry run, nothing is published'],
    ['Commit', identity.commit ? `\`${identity.commit}\`` : 'unknown'],
    ['Activepieces pin (`.ap-pin`)', `\`${identity.pin}\``],
    ['Artifact', `\`${identity.tarball}\``],
    ['sha256 of the artifact', `\`${identity.tarballSha256}\``],
    [`sha256 of \`${BUNDLE_PATH}\` inside it`, `\`${identity.bundleSha256}\``],
  ];

  const notes = `## \`${identity.name}\` ${identity.version}

Built by the release workflow from the tagged commit, with every check CI runs on a pull request:
lint, the test suite, the translation check, the check that the fetched Activepieces tree is
unmodified, the checks on the packed artifact, and the metadata snapshot that holds the piece's
surface still across pin bumps.

### Release identity

| | |
| --- | --- |
${rows.map(([label, value]) => `| ${label} | ${value} |`).join('\n')}

The piece ships as one bundled file with no install step, and the Activepieces framework and common
package are inlined into it from the pinned commit. Check a download against the tarball hash. The
hash of \`${BUNDLE_PATH}\` identifies the code that actually runs, and stays true when the
artifact is repackaged, as it is when npm serves a published version. Either way:

\`\`\`sh
shasum -a 256 ${identity.tarball}
tar -xzOf ${identity.tarball} ${BUNDLE_PATH} | shasum -a 256
\`\`\`

The build is reproducible: the same commit and the same pin pack a byte-identical tarball on
another machine. That is worth knowing but is not a substitute for the hashes above, because it only
holds while both stay where they are.

This version is never rebuilt or republished. Anything that needs fixing ships as a new version.
`;

  writeFileSync(join(ARTIFACTS_DIR, 'release-notes.md'), notes);
  writeFileSync(join(ARTIFACTS_DIR, 'release-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
  process.stdout.write(notes);
}

try {
  main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
