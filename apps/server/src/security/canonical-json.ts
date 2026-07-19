/**
 * Determinate canonical JSON serialization (N1):
 *
 * - Recursive sorted keys (top-level and nested objects).
 * - Arrays keep their original order.
 * - UTF-8 compact output: no whitespace between tokens.
 * - Rejects values that can't be represented deterministically:
 *   `undefined`, `bigint`, `symbol`, `function`, `object` with circular
 *   reference, `Date` (no standard cross-runtime serialization).
 */

export class UnsupportedValueError extends Error {
  readonly value: unknown;
  constructor(message: string, value: unknown) {
    super(message);
    this.name = 'UnsupportedValueError';
    this.value = value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function stringifyValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UnsupportedValueError(
        `Cannot serialize non-finite number: ${value}`,
        value,
      );
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);

  if (typeof value === 'undefined') {
    throw new UnsupportedValueError(
      'Cannot serialize undefined in canonical JSON',
      value,
    );
  }
  if (typeof value === 'bigint') {
    throw new UnsupportedValueError(
      'Cannot serialize BigInt in canonical JSON',
      value,
    );
  }
  if (typeof value === 'symbol') {
    throw new UnsupportedValueError(
      'Cannot serialize Symbol in canonical JSON',
      value,
    );
  }
  if (typeof value === 'function') {
    throw new UnsupportedValueError(
      'Cannot serialize Function in canonical JSON',
      value,
    );
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new UnsupportedValueError(
        'Cannot serialize circular reference in canonical JSON',
        value,
      );
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value.map((item) => stringifyValue(item, seen));
        return `[${items.join(',')}]`;
      }

      if (value instanceof Date) {
        throw new UnsupportedValueError(
          'Cannot serialize Date in canonical JSON (no standard cross-runtime serialization)',
          value,
        );
      }

      if (value instanceof RegExp) {
        throw new UnsupportedValueError(
          'Cannot serialize RegExp in canonical JSON',
          value,
        );
      }

      if (isPlainObject(value)) {
        const keys = Object.keys(value).sort();
        const entries = keys.map(
          (k) => `${JSON.stringify(k)}:${stringifyValue(value[k], seen)}`,
        );
        return `{${entries.join(',')}}`;
      }

      throw new UnsupportedValueError(
        `Cannot serialize non-plain object in canonical JSON: ${Object.prototype.toString.call(value)}`,
        value,
      );
    } finally {
      seen.delete(value);
    }
  }

  throw new UnsupportedValueError(
    `Unexpected value type: ${typeof value}`,
    value,
  );
}

/**
 * Serialize a value to canonical JSON.
 *
 * Throws `UnsupportedValueError` for values that can't be represented
 * deterministically. Detects and rejects circular references.
 */
export function canonicalJson(value: unknown): string {
  return stringifyValue(value, new WeakSet<object>());
}
