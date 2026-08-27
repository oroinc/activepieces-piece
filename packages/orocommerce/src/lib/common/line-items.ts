function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

function at({
  displayName,
  index,
  label,
}: {
  displayName: string;
  index: number;
  label: string;
}): string {
  return `${displayName} row ${index + 1}, "${label}"`;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'no value';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') {
    return Array.isArray(value) ? 'an array' : 'an object';
  }
  return String(value);
}

function toMinorUnits(value: number): number {
  return Math.round(Number((value * 100).toFixed(4)));
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL_NUMBER.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readRows({
  value,
  arrayKey,
  displayName,
}: ReadRowsParams): LineItemRow[] {
  const container = isRecord(value) ? value : undefined;
  const raw =
    container?.[arrayKey] ?? (Array.isArray(value) ? value : undefined);

  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new Error(
      `${displayName}: expected a list of rows, got ${describeValue(raw)}.`
    );
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `${displayName}: add at least one row before running this step.`
    );
  }

  return raw.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(
        `${displayName} row ${index + 1}: expected a set of fields, got ${describeValue(row)}.`
      );
    }
    return row;
  });
}

function requiredNumber({
  row,
  index,
  field,
  label,
  displayName,
  integer = false,
  min,
}: NumberFieldParams): number {
  const parsed = parseNumber(row[field]);

  if (parsed === undefined) {
    throw new Error(
      `${at({ displayName, index, label })} must be a number, got ${describeValue(row[field])}.`
    );
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new Error(
      `${at({ displayName, index, label })} must be a whole number, got ${parsed}.`
    );
  }
  if (min !== undefined && parsed < min) {
    throw new Error(
      `${at({ displayName, index, label })} must be ${min} or greater, got ${parsed}.`
    );
  }

  return parsed;
}

function optionalNumber({
  row,
  index,
  field,
  label,
  displayName,
  integer = false,
  min,
}: NumberFieldParams): number | undefined {
  if (isBlank(row[field])) {
    return undefined;
  }
  return requiredNumber({ row, index, field, label, displayName, integer, min });
}

function requiredString({
  row,
  index,
  field,
  label,
  displayName,
  maxLength,
}: StringFieldParams): string {
  const value = row[field];

  if (isBlank(value)) {
    throw new Error(
      `${at({ displayName, index, label })} is required, got ${describeValue(value)}.`
    );
  }
  if (typeof value !== 'string') {
    throw new Error(
      `${at({ displayName, index, label })} must be text, got ${describeValue(value)}.`
    );
  }
  const trimmed = value.trim();
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new Error(
      `${at({ displayName, index, label })} must be ${maxLength} characters or fewer, got ${trimmed.length}.`
    );
  }

  return trimmed;
}

function optionalString({
  row,
  index,
  field,
  label,
  displayName,
  maxLength,
}: StringFieldParams): string | undefined {
  if (isBlank(row[field])) {
    return undefined;
  }
  return requiredString({ row, index, field, label, displayName, maxLength });
}

function assertSumMatches({
  rows,
  field,
  label,
  displayName,
  total,
  totalLabel,
  toleranceMinorUnits = 0,
}: SumParams): void {
  const expected = parseNumber(total);
  if (expected === undefined) {
    throw new Error(
      `"${totalLabel}" must be a number, got ${describeValue(total)}.`
    );
  }

  const sum = rows.reduce(
    (acc, row, index) =>
      acc + requiredNumber({ row, index, field, label, displayName }),
    0
  );

  if (Math.abs(toMinorUnits(sum) - toMinorUnits(expected)) > toleranceMinorUnits) {
    throw new Error(
      `"${totalLabel}" is ${expected}, but the sum of "${label}" across ${rows.length} row(s) is ${sum}. ` +
        `Correct the total or the row amounts.`
    );
  }
}

export const lineItemUtils = {
  readRows,
  requiredNumber,
  optionalNumber,
  requiredString,
  optionalString,
  assertSumMatches,
};

const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export type LineItemRow = Record<string, unknown>;

type ReadRowsParams = {
  value: unknown;
  arrayKey: string;
  displayName: string;
};

type FieldParams = {
  row: LineItemRow;
  index: number;
  field: string;
  label: string;
  displayName: string;
};

type NumberFieldParams = FieldParams & {
  integer?: boolean;
  min?: number;
};

type StringFieldParams = FieldParams & {
  maxLength?: number;
};

type SumParams = {
  rows: LineItemRow[];
  field: string;
  label: string;
  displayName: string;
  total: unknown;
  totalLabel: string;
  toleranceMinorUnits?: number;
};
