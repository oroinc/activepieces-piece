import { describe, expect, it } from 'vitest';
import { booleanUpdateDropdown, readBooleanUpdate, LEAVE_UNCHANGED } from '../src/lib/common';

describe('readBooleanUpdate', () => {
  it('sends a value only for the two explicit choices', () => {
    expect(readBooleanUpdate('true')).toBe(true);
    expect(readBooleanUpdate('false')).toBe(false);
  });

  it('sends nothing for the default choice or an absent value', () => {
    expect(readBooleanUpdate(LEAVE_UNCHANGED)).toBeUndefined();
    expect(readBooleanUpdate(undefined)).toBeUndefined();
    expect(readBooleanUpdate('')).toBeUndefined();
  });

  it('ignores the `false` a step saved by the checkbox version of the prop still holds', () => {
    expect(readBooleanUpdate(false)).toBeUndefined();
    expect(readBooleanUpdate(true)).toBe(true);
  });
});

describe('booleanUpdateDropdown', () => {
  it('offers three states and defaults to leaving the value alone', () => {
    const prop = booleanUpdateDropdown({
      displayName: 'Enabled',
      description: 'Enable or disable the user account.',
    });

    expect(prop.defaultValue).toBe(LEAVE_UNCHANGED);
    expect(prop.required).toBe(false);
    expect(prop.options.options.map((option) => option.value)).toEqual([
      LEAVE_UNCHANGED,
      'true',
      'false',
    ]);
  });
});
