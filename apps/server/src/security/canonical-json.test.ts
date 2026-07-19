import { describe, it, expect } from 'vitest';
import { canonicalJson, UnsupportedValueError } from './canonical-json.js';
import { payloadHash } from './payload-hash.js';

// ── Success Path ──────────────────────────────────────────────────────────

describe('canonicalJson', () => {
  it('serializes null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('serializes booleans', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('serializes finite numbers', () => {
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-0)).toBe('0'); // -0 serializes to 0
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-1.5)).toBe('-1.5');
    expect(canonicalJson(3.14e10)).toBe('31400000000');
  });

  it('serializes strings', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson('')).toBe('""');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson('a\nb')).toBe('"a\\nb"');
  });

  it('serializes empty arrays', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('serializes arrays preserving order', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('serializes nested arrays', () => {
    expect(canonicalJson([1, [2, 3], 4])).toBe('[1,[2,3],4]');
  });

  it('serializes empty object', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('sorts object keys alphabetically', () => {
    expect(canonicalJson({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys recursively', () => {
    const input = { outer: { z: 1, a: 2 }, b: 3 };
    expect(canonicalJson(input)).toBe('{"b":3,"outer":{"a":2,"z":1}}');
  });

  it('produces compact output (no whitespace)', () => {
    const output = canonicalJson({ a: [1, 2], b: { c: 3 } });
    expect(output).toBe('{"a":[1,2],"b":{"c":3}}');
    expect(output).not.toContain(' ');
    expect(output).not.toContain('\n');
    expect(output).not.toContain('\t');
  });

  it('serializes mixed types in arrays', () => {
    expect(canonicalJson([1, 'hello', null, true, { a: 1 }])).toBe(
      '[1,"hello",null,true,{"a":1}]',
    );
  });
});

// ── Determinism ───────────────────────────────────────────────────────────

describe('canonicalJson determinism', () => {
  it('equivalent objects (different insertion order) produce same output', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, y: 2, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('deeply equivalent objects produce same output', () => {
    const a = { outer: { b: 2, a: 1 }, inner: [3, 4] };
    const b = { inner: [3, 4], outer: { a: 1, b: 2 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

// ── Payload Hash ──────────────────────────────────────────────────────────

describe('payloadHash', () => {
  it('same object (different key order) produces same hash', () => {
    const h1 = payloadHash({ b: 2, a: 1 });
    const h2 = payloadHash({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it('different values produce different hashes', () => {
    const h1 = payloadHash({ a: 1, b: 2 });
    const h2 = payloadHash({ a: 1, b: 3 });
    expect(h1).not.toBe(h2);
  });

  it('returns a 64-character lowercase hex string', () => {
    const hash = payloadHash({ test: true });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Failure Path ──────────────────────────────────────────────────────────

describe('canonicalJson rejection', () => {
  it('rejects undefined', () => {
    expect(() => canonicalJson(undefined)).toThrow(UnsupportedValueError);
  });

  it('rejects BigInt', () => {
    expect(() => canonicalJson(BigInt(42))).toThrow(UnsupportedValueError);
  });

  it('rejects Symbol', () => {
    expect(() => canonicalJson(Symbol('test'))).toThrow(UnsupportedValueError);
  });

  it('rejects a function', () => {
    expect(() => canonicalJson(() => 1)).toThrow(UnsupportedValueError);
  });

  it('rejects Infinity', () => {
    expect(() => canonicalJson(Infinity)).toThrow(UnsupportedValueError);
  });

  it('rejects -Infinity', () => {
    expect(() => canonicalJson(-Infinity)).toThrow(UnsupportedValueError);
  });

  it('rejects NaN', () => {
    expect(() => canonicalJson(NaN)).toThrow(UnsupportedValueError);
  });

  it('rejects Date', () => {
    expect(() => canonicalJson(new Date())).toThrow(UnsupportedValueError);
  });

  it('rejects RegExp', () => {
    expect(() => canonicalJson(/abc/)).toThrow(UnsupportedValueError);
  });

  it('rejects a non-plain object (class instance)', () => {
    class Foo {}
    expect(() => canonicalJson(new Foo())).toThrow(UnsupportedValueError);
  });
});

// ── Circular Reference Detection ──────────────────────────────────────────

describe('circular reference detection', () => {
  it('rejects direct circular object', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(UnsupportedValueError);
  });

  it('rejects indirect circular objects', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { ref: a };
    a.ref = b;
    expect(() => canonicalJson(a)).toThrow(UnsupportedValueError);
  });

  it('rejects circular arrays', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(UnsupportedValueError);
  });

  it('non-circular repeated reference is fine', () => {
    const inner = { x: 1 };
    const outer = { a: inner, b: inner };
    expect(canonicalJson(outer)).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

// ── Security / Edge Cases ─────────────────────────────────────────────────

describe('security and edge cases', () => {
  it('string with special characters is properly escaped', () => {
    const result = canonicalJson({ s: 'hello\nworld\t"quoted"' });
    // JSON must escape the characters properly
    expect(JSON.parse(result)).toEqual({ s: 'hello\nworld\t"quoted"' });
  });

  it('prototype pollution keys are sorted like any other key', () => {
    // Create object with __proto__ as own property, not via literal syntax
    const obj = Object.create(null);
    Object.defineProperty(obj, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { x: 1 },
    });
    obj.a = 2;
    const result = canonicalJson(obj);
    expect(result).toBe('{"__proto__":{"x":1},"a":2}');
    // The resulting JSON should not have polluted Object.prototype
    const parsed = JSON.parse(result);
    expect(parsed.__proto__).toEqual({ x: 1 });
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('constructor key is handled as a normal key', () => {
    const result = canonicalJson({ constructor: { x: 1 }, a: 2 });
    expect(result).toBe('{"a":2,"constructor":{"x":1}}');
  });

  it('empty string keys are sorted correctly', () => {
    expect(canonicalJson({ '': 1, a: 2 })).toBe('{"":1,"a":2}');
  });

  it('deeply nested object', () => {
    const deep = { level1: { level2: { level3: { a: 1, b: 2 } } } };
    const result = canonicalJson(deep);
    expect(result).toBe(
      '{"level1":{"level2":{"level3":{"a":1,"b":2}}}}',
    );
    // Verify round-trip
    expect(JSON.parse(result)).toEqual(deep);
  });

  it('object with null prototype', () => {
    const obj = Object.create(null);
    obj.a = 1;
    obj.z = 2;
    expect(canonicalJson(obj)).toBe('{"a":1,"z":2}');
  });

  it('array with null values', () => {
    expect(canonicalJson([null, 1])).toBe('[null,1]');
  });
});
