import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_HEADER,
  buildEnvDev,
  parseLocalEnv,
  resolveSource,
  sourceFolder,
  strayPieceFolders,
} from '../../../scripts/dev-ap-lib.mjs';

const UPSTREAM = 'https://github.com/activepieces/activepieces.git';
const PIN = 'f'.repeat(40);

/** Shaped like upstream's committed .env.dev: quoted and bare values, a comment, a blank line. */
const COMMITTED = [
  'AP_DB_TYPE=PGLITE',
  'AP_DEV_PIECES="google-sheets,store"',
  'AP_LOG_LEVEL=debug',
  'AP_JWT_SECRET=dev-secret-please-change-in-production',
  '',
  '## Test Local Only',
  'AP_QUEUE_UI_PASSWORD=admin',
  '',
].join('\n');

const OWN = [
  ['AP_DEV_PIECES', '"orocommerce"'],
  ['AP_REUSE_SANDBOX', 'false'],
];

const env = (local) => buildEnvDev(COMMITTED, parseLocalEnv(local), OWN);
const lines = (text) => text.split('\n');

describe('buildEnvDev', () => {
  it('starts with the generated-file comment and keeps every committed value it does not override', () => {
    const { text, applied, ignored } = env('');
    expect(lines(text)[0]).toBe(GENERATED_HEADER);
    expect(lines(text)[0].startsWith('# ')).toBe(true);
    expect(text).toContain('\nAP_LOG_LEVEL=debug\n');
    expect(text).toContain('\nAP_JWT_SECRET=dev-secret-please-change-in-production\n');
    expect(text).toContain('\n## Test Local Only\n');
    expect(applied).toEqual([]);
    expect(ignored).toEqual([]);
  });

  it('sets the script keys, replacing the committed AP_DEV_PIECES in place', () => {
    const { text } = env('');
    expect(lines(text).filter((line) => line.startsWith('AP_DEV_PIECES='))).toEqual([
      'AP_DEV_PIECES="orocommerce"',
    ]);
    expect(lines(text).indexOf('AP_DEV_PIECES="orocommerce"')).toBe(2);
    expect(text).toContain('\nAP_REUSE_SANDBOX=false\n');
  });

  it('lets a .env.dev.local line win over the committed value, and adds new keys', () => {
    const { text, applied } = env('AP_LOG_LEVEL=info\nMY_KEY=1\n');
    expect(text).toContain('\nAP_LOG_LEVEL=info\n');
    expect(text).not.toContain('AP_LOG_LEVEL=debug');
    expect(text).toContain('\nMY_KEY=1\n');
    expect(applied).toEqual(['AP_LOG_LEVEL', 'MY_KEY']);
  });

  it('brings the committed value back once the line is deleted from .env.dev.local', () => {
    expect(env('AP_LOG_LEVEL=info\nMY_KEY=1').text).toContain('\nAP_LOG_LEVEL=info\n');
    const { text } = env('');
    expect(text).toContain('\nAP_LOG_LEVEL=debug\n');
    expect(text).not.toContain('MY_KEY');
    expect(text).toBe(
      `${GENERATED_HEADER}\n${COMMITTED.replace('"google-sheets,store"', '"orocommerce"')}` +
        'AP_REUSE_SANDBOX=false\n'
    );
  });

  it('ignores the script keys in .env.dev.local and reports them', () => {
    const { text, applied, ignored } = env('AP_DEV_PIECES=other\nAP_REUSE_SANDBOX=true\nAP_REUSE_SANDBOX=1');
    expect(ignored).toEqual(['AP_DEV_PIECES', 'AP_REUSE_SANDBOX']);
    expect(applied).toEqual([]);
    expect(text).toContain('\nAP_DEV_PIECES="orocommerce"\n');
    expect(text).toContain('\nAP_REUSE_SANDBOX=false\n');
    expect(text).not.toContain('other');
  });

  it('never copies DEV_AP_REPO or DEV_AP_REF, and does not report them', () => {
    const { text, applied, ignored } = env('DEV_AP_REPO=https://example.com/a.git\nDEV_AP_REF=main');
    expect(text).not.toContain('DEV_AP_');
    expect(applied).toEqual([]);
    expect(ignored).toEqual([]);
  });

  it('writes a $ in a value as it is, for both a replaced and an added key', () => {
    const value = 'a$1b$&c$$d$`e$\'f';
    const { text } = env(`AP_JWT_SECRET=${value}\nNEW_SECRET=${value}`);
    expect(text).toContain(`\nAP_JWT_SECRET=${value}\n`);
    expect(text).toContain(`\nNEW_SECRET=${value}\n`);
  });

  it('collapses every committed line for an overridden key into one', () => {
    const { text } = buildEnvDev('A=1\nB=2\nA=3\n', parseLocalEnv('A=9'), []);
    expect(text).toBe(`${GENERATED_HEADER}\nA=9\nB=2\nA=9\n`);
  });
});

describe('parseLocalEnv', () => {
  it('skips blank lines and comments, and refuses anything that is not KEY=value', () => {
    expect(parseLocalEnv('# note\n\nA=1\r\nB="two words"\n')).toEqual([
      ['A', '1'],
      ['B', '"two words"'],
    ]);
    expect(() => parseLocalEnv('export A=1')).toThrow(/expected KEY=value/);
  });
});

describe('resolveSource', () => {
  const resolve = (local) => resolveSource(parseLocalEnv(local), UPSTREAM, PIN);
  const failure = (local) => {
    try {
      resolve(local);
    } catch (error) {
      return error.message;
    }
    return null;
  };
  const hash12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

  it('is upstream at .ap-pin in .ap-dev with neither key, or with both empty', () => {
    const expected = { isDefault: true, repo: UPSTREAM, ref: null, folder: '.ap-dev' };
    expect(resolve('')).toEqual(expected);
    expect(resolve('DEV_AP_REPO=\nDEV_AP_REF=')).toEqual(expected);
  });

  it('takes DEV_AP_REF alone as a ref of upstream, in a folder named from the hash', () => {
    expect(resolve('DEV_AP_REF=1.2.3')).toEqual({
      isDefault: false,
      repo: UPSTREAM,
      ref: '1.2.3',
      folder: `.ap-dev-${hash12(`${UPSTREAM}\n1.2.3`)}`,
    });
  });

  it('uses DEV_AP_REPO with DEV_AP_REF, unquoting both, last line winning', () => {
    const source = resolve(
      'DEV_AP_REPO=https://example.com/old.git\nDEV_AP_REPO="https://github.com/<org>/<repo>.git"\n' +
        "DEV_AP_REF='feature/x'"
    );
    expect(source.repo).toBe('https://github.com/<org>/<repo>.git');
    expect(source.ref).toBe('feature/x');
    expect(source.folder).toBe(sourceFolder('https://github.com/<org>/<repo>.git', 'feature/x'));
    expect(source.folder).toMatch(/^\.ap-dev-[0-9a-f]{12}$/);
  });

  it('gives each repo and ref its own folder', () => {
    const folders = new Set([
      sourceFolder(UPSTREAM, 'main'),
      sourceFolder(UPSTREAM, 'other'),
      sourceFolder('git@example.com:org/repo.git', 'main'),
    ]);
    expect(folders.size).toBe(3);
  });

  it('is the default source when DEV_AP_REF is the .ap-pin sha of upstream, named or not', () => {
    const expected = { isDefault: true, repo: UPSTREAM, ref: null, folder: '.ap-dev' };
    expect(resolve(`DEV_AP_REF=${PIN}`)).toEqual(expected);
    expect(resolve(`DEV_AP_REPO=${UPSTREAM}\nDEV_AP_REF=${PIN}`)).toEqual(expected);
    const elsewhere = resolve(`DEV_AP_REPO=git@example.com:org/a.git\nDEV_AP_REF=${PIN}`);
    expect(elsewhere.isDefault).toBe(false);
    expect(elsewhere.folder).toBe(sourceFolder('git@example.com:org/a.git', PIN));
  });

  it('refuses a value starting with "-", which git would read as an option', () => {
    expect(failure("DEV_AP_REF=--upload-pack=sh -c 'echo INJECTED >&2; exit 1'")).toMatch(
      /DEV_AP_REF starts with "-"/
    );
    expect(failure('DEV_AP_REPO=--upload-pack=x\nDEV_AP_REF=main')).toMatch(/DEV_AP_REPO starts with "-"/);
    expect(failure('DEV_AP_REPO=-\nDEV_AP_REF=main')).toMatch(/DEV_AP_REPO starts with "-"/);
    expect(failure('DEV_AP_REF=-')).toMatch(/DEV_AP_REF starts with "-"/);
  });

  it('refuses DEV_AP_REPO without DEV_AP_REF', () => {
    expect(() => resolve('DEV_AP_REPO=https://example.com/a.git')).toThrow(/DEV_AP_REPO but not DEV_AP_REF/);
  });

  it('refuses any user name, password or token in an http(s) URL, and does not repeat it', () => {
    for (const url of [
      'https://user:s3cret@example.com/a.git',
      'https://ghp_s3cret@github.com/org/a.git',
      'http://s3cret@example.com/a.git',
    ]) {
      const message = failure(`DEV_AP_REPO=${url}\nDEV_AP_REF=main`);
      expect(message).toMatch(/user name, password or token/);
      expect(message).not.toContain('s3cret');
    }
  });

  it('accepts both SSH forms, and an @ in the path of an https URL', () => {
    for (const url of [
      'ssh://git@example.com/org/a.git',
      'git@example.com:org/a.git',
      'https://example.com/org/a@b.git',
    ]) {
      expect(resolve(`DEV_AP_REPO=${url}\nDEV_AP_REF=main`).repo).toBe(url);
    }
  });
});

describe('strayPieceFolders', () => {
  const keep = 'packages/pieces/custom/orocommerce';

  it('finds a tracked orocommerce piece anywhere but the custom slot', () => {
    expect(
      strayPieceFolders(
        [
          'packages/pieces/community/orocommerce/package.json',
          'packages/pieces/custom/orocommerce/package.json',
          'orocommerce/package.json',
          'packages/pieces/community/not-orocommerce/package.json',
          'packages/pieces/community/orocommerce/src/index.ts',
          '',
        ],
        'orocommerce',
        keep
      )
    ).toEqual(['packages/pieces/community/orocommerce', 'orocommerce']);
  });

  it('finds nothing in a tree without one', () => {
    expect(strayPieceFolders([`${keep}/package.json`, ''], 'orocommerce', keep)).toEqual([]);
  });
});
