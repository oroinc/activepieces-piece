import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(__dirname, '..');

function runCheck(args: string[] = []) {
  return spawnSync(process.execPath, ['tools/check-i18n.mjs', ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
}

describe('i18n', () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  it('keeps src/i18n in sync with the piece metadata', () => {
    const { status, stdout, stderr } = runCheck();

    expect(status, `${stdout}${stderr}`).toBe(0);
  });

  it('ships English only', () => {
    const { stdout } = runCheck();

    expect(stdout).toContain('English only');
  });

  /**
   * The piece dropped its translations, so a locale file reappearing is a mistake: Activepieces
   * would load it and serve whatever it holds.
   */
  it('rejects a locale file that reappears beside the English source', () => {
    scratch = mkdtempSync(join(tmpdir(), 'oro-i18n-'));
    cpSync(join(PACKAGE_ROOT, 'src', 'i18n'), scratch, { recursive: true });
    writeFileSync(join(scratch, 'de.json'), '{}\n');

    const { status, stdout, stderr } = runCheck([`--i18n-dir=${scratch}`]);

    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('English only');
    expect(`${stdout}${stderr}`).toContain('de.json');
  });
});
