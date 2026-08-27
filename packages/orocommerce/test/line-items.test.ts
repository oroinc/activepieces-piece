import { describe, expect, it } from 'vitest';
import { lineItemUtils } from '../src/lib/common/line-items';

const displayName = 'Line Items';

describe('lineItemUtils.readRows', () => {
  it('unwraps the DynamicProperties container', () => {
    const rows = lineItemUtils.readRows({
      value: { lineItems: [{ quantity: 1 }] },
      arrayKey: 'lineItems',
      displayName,
    });
    expect(rows).toEqual([{ quantity: 1 }]);
  });

  it('accepts a plain array', () => {
    const rows = lineItemUtils.readRows({
      value: [{ quantity: 2 }],
      arrayKey: 'lineItems',
      displayName,
    });
    expect(rows).toEqual([{ quantity: 2 }]);
  });

  it('rejects an empty or missing collection', () => {
    expect(() =>
      lineItemUtils.readRows({ value: {}, arrayKey: 'lineItems', displayName })
    ).toThrow(/add at least one row/);
    expect(() =>
      lineItemUtils.readRows({
        value: { lineItems: [] },
        arrayKey: 'lineItems',
        displayName,
      })
    ).toThrow(/add at least one row/);
    expect(() =>
      lineItemUtils.readRows({
        value: undefined,
        arrayKey: 'lineItems',
        displayName,
      })
    ).toThrow(/add at least one row/);
  });

  it('reports a value that is not a list as such, not as an empty one', () => {
    expect(() =>
      lineItemUtils.readRows({
        value: { lineItems: 'nope' },
        arrayKey: 'lineItems',
        displayName,
      })
    ).toThrow('Line Items: expected a list of rows, got "nope".');
    expect(() =>
      lineItemUtils.readRows({ value: { lineItems: 5 }, arrayKey: 'lineItems', displayName })
    ).toThrow('Line Items: expected a list of rows, got 5.');
    expect(() =>
      lineItemUtils.readRows({
        value: { lineItems: { lineItems: [{ quantity: 1 }] } },
        arrayKey: 'lineItems',
        displayName,
      })
    ).toThrow('Line Items: expected a list of rows, got an object.');
  });

  it('rejects non-object rows and reports a 1-based index', () => {
    expect(() =>
      lineItemUtils.readRows({
        value: { lineItems: [{ quantity: 1 }, 'oops'] },
        arrayKey: 'lineItems',
        displayName,
      })
    ).toThrow(/row 2: expected a set of fields, got "oops"/);
  });
});

describe('lineItemUtils.requiredNumber', () => {
  const base = { index: 0, field: 'quantity', label: 'Quantity', displayName };

  it('accepts numbers and numeric strings', () => {
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: 3 } })).toBe(3);
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: ' 2.5 ' } })).toBe(2.5);
  });

  it('rejects missing values instead of producing NaN', () => {
    expect(() => lineItemUtils.requiredNumber({ ...base, row: {} })).toThrow(
      /"Quantity" must be a number, got no value/
    );
  });

  it('rejects a blank string instead of producing 0', () => {
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: '   ' } })
    ).toThrow(/must be a number/);
  });

  it('rejects non-numeric strings, NaN and Infinity', () => {
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: 'abc' } })
    ).toThrow(/must be a number, got "abc"/);
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: Number.NaN } })
    ).toThrow(/must be a number/);
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: Number.POSITIVE_INFINITY } })
    ).toThrow(/must be a number/);
  });

  it('rejects the non-decimal literals Number() would happily parse', () => {
    for (const value of ['0x10', '0b101', '0o17', '1_000', '1,000', '$5', '5%']) {
      expect(() =>
        lineItemUtils.requiredNumber({ ...base, row: { quantity: value } })
      ).toThrow(`must be a number, got "${value}"`);
    }
  });

  it('still accepts the decimal forms a user may reasonably type', () => {
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: '+5' } })).toBe(5);
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: '-5' } })).toBe(-5);
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: '.5' } })).toBe(0.5);
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: '5.' } })).toBe(5);
    expect(lineItemUtils.requiredNumber({ ...base, row: { quantity: '1e3' } })).toBe(1000);
  });

  it('rejects a boolean that Number() would silently turn into 1', () => {
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: true } })
    ).toThrow(/must be a number, got true/);
  });

  it('enforces integer and min constraints', () => {
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: 1.5 }, integer: true })
    ).toThrow(/must be a whole number/);
    expect(() =>
      lineItemUtils.requiredNumber({ ...base, row: { quantity: -1 }, min: 0 })
    ).toThrow(/must be 0 or greater/);
    expect(
      lineItemUtils.requiredNumber({ ...base, row: { quantity: 0 }, min: 0 })
    ).toBe(0);
  });
});

describe('lineItemUtils.optionalNumber', () => {
  const base = { index: 1, field: 'note', label: 'Note', displayName };

  it('returns undefined for empty input', () => {
    expect(lineItemUtils.optionalNumber({ ...base, row: {} })).toBeUndefined();
    expect(lineItemUtils.optionalNumber({ ...base, row: { note: '' } })).toBeUndefined();
    expect(lineItemUtils.optionalNumber({ ...base, row: { note: null } })).toBeUndefined();
  });

  it('treats a whitespace-only value as absent rather than failing the run', () => {
    expect(lineItemUtils.optionalNumber({ ...base, row: { note: '   ' } })).toBeUndefined();
  });

  it('still validates a provided value', () => {
    expect(() =>
      lineItemUtils.optionalNumber({ ...base, row: { note: 'x' } })
    ).toThrow(/row 2, "Note" must be a number/);
  });
});

describe('lineItemUtils.requiredString', () => {
  const base = { index: 0, field: 'description', label: 'Description', displayName };

  it('rejects blank values', () => {
    expect(() =>
      lineItemUtils.requiredString({ ...base, row: { description: '   ' } })
    ).toThrow(/is required/);
    expect(() =>
      lineItemUtils.requiredString({ ...base, row: {} })
    ).toThrow(/is required, got no value/);
  });

  it('reports a wrong type as a type problem, not as a missing value', () => {
    expect(() =>
      lineItemUtils.requiredString({ ...base, row: { description: 42 } })
    ).toThrow(/must be text, got 42/);
  });

  it('trims surrounding whitespace so ids stay usable as relationship targets', () => {
    expect(
      lineItemUtils.requiredString({
        ...base,
        row: { description: '  Widget  ' },
      })
    ).toBe('Widget');
  });

  it('enforces maxLength', () => {
    expect(() =>
      lineItemUtils.requiredString({
        ...base,
        row: { description: 'abcdef' },
        maxLength: 3,
      })
    ).toThrow(/3 characters or fewer, got 6/);
  });
});

describe('lineItemUtils.optionalString', () => {
  const base = { index: 0, field: 'note', label: 'Note', displayName };

  it('returns undefined for empty input', () => {
    expect(lineItemUtils.optionalString({ ...base, row: {} })).toBeUndefined();
    expect(lineItemUtils.optionalString({ ...base, row: { note: '' } })).toBeUndefined();
  });

  it('treats a whitespace-only value as absent rather than failing the run', () => {
    expect(lineItemUtils.optionalString({ ...base, row: { note: '   ' } })).toBeUndefined();
  });
});

describe('lineItemUtils.assertSumMatches', () => {
  const params = {
    field: 'rowTotal',
    label: 'Row Total',
    displayName,
    totalLabel: 'Total Amount',
  };

  it('passes when the rows add up', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({
        ...params,
        rows: [{ rowTotal: 10.1 }, { rowTotal: 20.2 }],
        total: 30.3,
      })
    ).not.toThrow();
  });

  it('is immune to binary floating point drift', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({
        ...params,
        rows: [{ rowTotal: 0.1 }, { rowTotal: 0.2 }],
        total: 0.3,
      })
    ).not.toThrow();
  });

  it('reports the mismatch with both figures', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({
        ...params,
        rows: [{ rowTotal: 10 }, { rowTotal: 5 }],
        total: 20,
      })
    ).toThrow(/"Total Amount" is 20, but the sum of "Row Total" across 2 row\(s\) is 15/);
  });

  it('honours an explicit rounding tolerance', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({
        ...params,
        rows: [{ rowTotal: 10 }, { rowTotal: 5 }],
        total: 15.01,
        toleranceMinorUnits: 1,
      })
    ).not.toThrow();
  });

  it('accepts a half-cent total at zero tolerance, where value * 100 rounds down', () => {
    for (const [row, total] of [[1.005, 1.01], [0.145, 0.15], [8.165, 8.17]] as const) {
      expect(() =>
        lineItemUtils.assertSumMatches({ ...params, rows: [{ rowTotal: row }], total })
      ).not.toThrow();
    }
  });

  it('still rejects a real discrepancy at zero tolerance', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({ ...params, rows: [{ rowTotal: 10.005 }], total: 10 })
    ).toThrow(/"Total Amount" is 10, but the sum of "Row Total"/);
  });

  it('rejects a non-numeric total', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({ ...params, rows: [{ rowTotal: 1 }], total: 'x' })
    ).toThrow(/"Total Amount" must be a number, got "x"/);
  });

  it('surfaces an invalid row amount rather than summing it as NaN', () => {
    expect(() =>
      lineItemUtils.assertSumMatches({
        ...params,
        rows: [{ rowTotal: 1 }, {}],
        total: 1,
      })
    ).toThrow(/row 2, "Row Total" must be a number/);
  });
});
