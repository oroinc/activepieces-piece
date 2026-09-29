#!/usr/bin/env node
/**
 * Hold the piece's public surface still across upstream pin bumps.
 *
 * A large part of what the piece exposes does not come from this repository. The shared HTTP action,
 * and every prop on it, comes from @activepieces/pieces-common, so moving .ap-pin can rename a label,
 * change a property type or make a required field optional without a single line of this repository
 * changing. That happened on the move to 0.92.0: seven props of custom_api_call changed, and it was
 * only visible by unpacking two tarballs side by side.
 *
 * This walks the built bundle and writes what it finds to a committed snapshot, so the next pin bump
 * carries those changes in its own diff, where a reviewer sees them.
 *
 *   node scripts/metadata-snapshot.mjs           compare, exit 1 on any difference
 *   node scripts/metadata-snapshot.mjs --write   accept the current surface
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIECE_DIR = join(REPO_ROOT, 'packages', 'orocommerce');
const BUNDLE = join(PIECE_DIR, 'dist', 'src', 'index.js');
const SNAPSHOT = join(PIECE_DIR, 'metadata.snapshot.json');

/**
 * Read in a child process: the bundle is a piece of built output, and loading it into the process
 * that then writes the snapshot would let it influence what gets written.
 */
function readSurface(bundlePath) {
  const probe = `
    const piece = (() => {
      const loaded = require(${JSON.stringify(bundlePath)});
      return loaded[Object.keys(loaded)[0]];
    })();

    // actions()/triggers() are accessors on the prototype, _actions/_triggers the maps behind them.
    const asMap = (value) => (typeof value === 'function' ? value.call(piece) : value) || {};
    // Only plain metadata is recorded. Anything callable - dynamic dropdown options, refreshers -
    // is state this cannot capture, so it is named rather than invoked.
    const scalar = (value) => {
      if (typeof value === 'function') return '<function>';
      if (value === undefined) return null;
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(scalar);
      return undefined;
    };
    const props = (source) => {
      const out = {};
      for (const name of Object.keys(source || {}).sort()) {
        const prop = source[name] || {};
        out[name] = {
          type: prop.type ?? null,
          displayName: scalar(prop.displayName) ?? null,
          description: scalar(prop.description) ?? null,
          required: prop.required ?? null,
          defaultValue: scalar(prop.defaultValue) ?? null,
        };
      }
      return out;
    };
    const entries = (map) => {
      const out = {};
      for (const name of Object.keys(map).sort()) {
        const item = map[name];
        out[name] = {
          displayName: scalar(item.displayName) ?? null,
          description: scalar(item.description) ?? null,
          requireAuth: item.requireAuth ?? null,
          type: item.type ?? null,
          props: props(item.props),
        };
      }
      return out;
    };

    process.stdout.write(JSON.stringify({
      piece: {
        displayName: piece.displayName ?? null,
        description: scalar(piece.description) ?? null,
        minimumSupportedRelease: piece.minimumSupportedRelease ?? null,
        maximumSupportedRelease: piece.maximumSupportedRelease ?? null,
        categories: piece.categories ?? null,
        authors: piece.authors ?? null,
      },
      auth: {
        type: piece.auth?.type ?? null,
        required: piece.auth?.required ?? null,
        props: props(piece.auth?.props),
      },
      actions: entries(asMap(piece.actions)),
      triggers: entries(asMap(piece.triggers)),
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: PIECE_DIR });
  if (result.status !== 0) {
    throw new Error(`Could not read the bundle:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/** Line-by-line so the failure names the prop that moved, not just "they differ". */
function differences(expected, actual, path = '') {
  const found = [];
  const keys = [...new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})])].sort();
  for (const key of keys) {
    const here = path ? `${path}.${key}` : key;
    const a = expected?.[key];
    const b = actual?.[key];
    const plain = (v) => v === null || typeof v !== 'object';
    if (!(key in (expected ?? {}))) found.push(`+ ${here} = ${JSON.stringify(b)}`);
    else if (!(key in (actual ?? {}))) found.push(`- ${here} = ${JSON.stringify(a)}`);
    else if (plain(a) || plain(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        found.push(`~ ${here}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
    } else found.push(...differences(a, b, here));
  }
  return found;
}

function main() {
  if (!existsSync(BUNDLE)) {
    console.error(`No bundle at ${BUNDLE}. Run npm run bundle first.`);
    process.exit(1);
  }
  const actual = readSurface(BUNDLE);
  const serialised = `${JSON.stringify(actual, null, 2)}\n`;

  if (process.argv.includes('--write')) {
    writeFileSync(SNAPSHOT, serialised);
    console.log(`Wrote ${SNAPSHOT}`);
    return;
  }

  if (!existsSync(SNAPSHOT)) {
    console.error(`No snapshot at ${SNAPSHOT}. Create it with: npm run metadata:write`);
    process.exit(1);
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const found = differences(expected, actual);
  if (found.length === 0) {
    const actionCount = Object.keys(actual.actions).length;
    const triggerCount = Object.keys(actual.triggers).length;
    console.log(`Metadata matches the snapshot: ${actionCount} action(s), ${triggerCount} trigger(s).`);
    return;
  }

  console.error(`The piece's surface differs from packages/orocommerce/metadata.snapshot.json:\n`);
  for (const line of found) console.error(`  ${line}`);
  console.error(
    `\n${found.length} difference(s). If this is a pin bump, the changes above are what the bump does ` +
      `to the piece. Accept them with "npm run metadata:write" in the same pull request, so the diff ` +
      `shows them.`
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
