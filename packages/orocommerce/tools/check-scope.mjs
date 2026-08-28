import { execFileSync } from 'node:child_process';

const PIECE_PATH = 'packages/pieces/community/orocommerce/';
const ALLOWED_OUTSIDE_PIECE = new Set(['bun.lock']);
const DEFAULT_BASE = 'origin/main';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readOption({ args, name, fallback }) {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function run() {
  const args = process.argv.slice(2);
  const base = readOption({ args, name: 'base', fallback: DEFAULT_BASE });

  try {
    git(['rev-parse', '--verify', `${base}^{commit}`]);
  } catch {
    console.error(
      `error: ${base} is not a known ref. Run "git fetch origin" first, or pass --base=<ref>.`
    );
    process.exit(1);
  }

  const changed = git(['diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean);
  const offenders = changed.filter(
    (file) => !file.startsWith(PIECE_PATH) && !ALLOWED_OUTSIDE_PIECE.has(file)
  );

  if (offenders.length > 0) {
    console.error(
      `error: ${offenders.length} file(s) outside ${PIECE_PATH} changed since ${base}:`
    );
    for (const file of offenders) {
      console.error(`    - ${file}`);
    }
    console.error(
      `\npoc/orocommerce is the branch proposed upstream, so it carries the piece and nothing else.` +
        `\nIf these are upstream's own changes, ${base} is stale — run "git fetch origin" and retry.`
    );
    process.exit(1);
  }

  const allowed = changed.filter((file) => ALLOWED_OUTSIDE_PIECE.has(file));
  console.log(
    `scope check passed: ${changed.length} file(s) changed since ${base}, ` +
      `${changed.length - allowed.length} inside ${PIECE_PATH}` +
      `${allowed.length > 0 ? ` and ${allowed.join(', ')}` : ''}.`
  );
}

run();
