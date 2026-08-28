import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(__dirname, '..');

describe('i18n', () => {
  it('keeps src/i18n in sync with the piece metadata', () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      ['tools/check-i18n.mjs'],
      { cwd: PACKAGE_ROOT, encoding: 'utf8' }
    );

    expect(status, `${stdout}${stderr}`).toBe(0);
  });
});
