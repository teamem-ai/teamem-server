/**
 * Recursive private-tag redaction tests (DUA-182).
 *
 * Covers: success paths (single, multiple, adjacent, multiline tags),
 * failure/edge paths (unclosed tags, no tags, empty strings, non-string
 * primitives), and security/counterexample paths (deeply nested input
 * immutability, SECRET leakage check, class-nested tags, adjacent tags).
 */
import { describe, expect, it } from 'vitest';
import { stripPrivateTags } from './private-tags.js';

// ── String-level: basic success paths ───────────────────────────────────────

describe('stripPrivateTags — string basics', () => {
  it('removes a single private section', () => {
    expect(stripPrivateTags('before <private>SECRET=abc123</private> after')).toBe('before  after');
  });

  it('returns the original string when no tags are present', () => {
    expect(stripPrivateTags('no tags here')).toBe('no tags here');
  });

  it('returns empty string for empty input', () => {
    expect(stripPrivateTags('')).toBe('');
  });

  it('removes a private section at start of string', () => {
    expect(stripPrivateTags('<private>SECRET</private> visible')).toBe(' visible');
  });

  it('removes a private section at end of string', () => {
    expect(stripPrivateTags('visible <private>SECRET</private>')).toBe('visible ');
  });

  it('removes when the entire string is a private section', () => {
    expect(stripPrivateTags('<private>all secret</private>')).toBe('');
  });
});

// ── String-level: multiple and adjacent tags ────────────────────────────────

describe('stripPrivateTags — multiple and adjacent tags', () => {
  it('removes multiple non-adjacent private sections', () => {
    expect(stripPrivateTags('<private>A</private> keep <private>B</private>')).toBe(' keep ');
  });

  it('removes adjacent private sections with no text between', () => {
    expect(stripPrivateTags('<private>A</private><private>B</private>')).toBe('');
  });

  it('handles three or more private sections', () => {
    expect(stripPrivateTags('x <private>1</private> y <private>2</private> z <private>3</private>')).toBe('x  y  z ');
  });
});

// ── String-level: multiline content ─────────────────────────────────────────

describe('stripPrivateTags — multiline content', () => {
  it('removes multiline private sections', () => {
    const input = `public line
<private>
line 2
line 3
</private>
after`;
    // Newlines outside the tag pair are preserved; only the tag pair and its
    // content are removed.  The newline after </private> is part of the
    // surrounding text, not inside the private section.
    expect(stripPrivateTags(input)).toBe(`public line

after`);
  });

  it('removes private section spanning many lines', () => {
    const input = `a <private>
1
2
3
4
5
</private> b`;
    expect(stripPrivateTags(input)).toBe('a  b');
  });
});

// ── String-level: unclosed tags ─────────────────────────────────────────────

describe('stripPrivateTags — unclosed tags', () => {
  it('removes from unclosed <private> to end of string', () => {
    expect(stripPrivateTags('before <private>secret no close')).toBe('before ');
  });

  it('handles only opening tag with nothing after', () => {
    expect(stripPrivateTags('<private>')).toBe('');
  });
});

// ── String-level: nested-like markers ───────────────────────────────────────

describe('stripPrivateTags — nested-like markers', () => {
  it('handles nested-looking tags by closing at first </private>', () => {
    // First <private> opens, first </private> closes. The inner <private>
    // is literal text that gets removed along with everything else.
    // The trailing </private> is left as literal text (single-pass scan).
    expect(stripPrivateTags('<private><private>x</private></private>')).toBe('</private>');
  });

  it('handles class-like nested tag text', () => {
    const input = 'text <private>class Foo { <private>bar</private> }</private> end';
    // First <private> opens at "class Foo", first </private> closes after "bar".
    // The trailing "</private>" is left as literal text (single-pass scan).
    expect(stripPrivateTags(input)).toBe('text  }</private> end');
  });
});

// ── Object and array traversal ──────────────────────────────────────────────

describe('stripPrivateTags — objects and arrays', () => {
  it('strips from string values in a flat object', () => {
    const input = { a: '<private>SECRET</private>', b: 'clean' };
    expect(stripPrivateTags(input)).toEqual({ a: '', b: 'clean' });
  });

  it('strips from nested objects', () => {
    const input = { outer: { inner: '<private>SECRET=abc123</private>' } };
    expect(stripPrivateTags(input)).toEqual({ outer: { inner: '' } });
  });

  it('strips from arrays of strings', () => {
    const input = ['<private>A</private>', 'keep', '<private>B</private>'];
    expect(stripPrivateTags(input)).toEqual(['', 'keep', '']);
  });

  it('strips from arrays of objects', () => {
    const input = [{ text: '<private>X</private>' }, { text: 'Y' }];
    expect(stripPrivateTags(input)).toEqual([{ text: '' }, { text: 'Y' }]);
  });

  it('handles deeply nested mixed structures', () => {
    const input = {
      level1: [
        { level2: { level3: '<private>DEEP SECRET</private>' } },
        ['<private>array secret</private>', 'safe'],
      ],
    };
    expect(stripPrivateTags(input)).toEqual({
      level1: [
        { level2: { level3: '' } },
        ['', 'safe'],
      ],
    });
  });
});

// ── Immutability: input is never mutated ────────────────────────────────────

describe('stripPrivateTags — immutability', () => {
  it('does not mutate a string input (strings are immutable in JS)', () => {
    const input = '<private>SECRET</private>';
    stripPrivateTags(input);
    expect(input).toBe('<private>SECRET</private>');
  });

  it('does not mutate a flat object input', () => {
    const input = { a: '<private>SECRET</private>', b: 'clean' };
    const original = JSON.parse(JSON.stringify(input));
    stripPrivateTags(input);
    expect(input).toEqual(original);
  });

  it('does not mutate a nested object input', () => {
    const input = { outer: { inner: '<private>SECRET</private>' } };
    const original = JSON.parse(JSON.stringify(input));
    stripPrivateTags(input);
    expect(input).toEqual(original);
  });

  it('does not mutate an array input', () => {
    const input = ['<private>A</private>', 'keep', '<private>B</private>'];
    const original = [...input];
    stripPrivateTags(input);
    expect(input).toEqual(original);
  });

  it('does not mutate a deeply nested fixture', () => {
    const input = {
      level1: [
        { level2: { level3: '<private>DEEP SECRET</private>' } },
        ['<private>array secret</private>', 'safe'],
      ],
    };
    const original = JSON.parse(JSON.stringify(input));
    stripPrivateTags(input);
    expect(input).toEqual(original);
  });

  it('returned value is a different reference for objects', () => {
    const input = { a: 'clean' };
    expect(stripPrivateTags(input)).not.toBe(input);
  });

  it('returned value is a different reference for arrays', () => {
    const input = ['clean'];
    expect(stripPrivateTags(input)).not.toBe(input);
  });
});

// ── Non-string primitives pass through ──────────────────────────────────────

describe('stripPrivateTags — non-string primitives', () => {
  it('passes numbers through unchanged', () => {
    expect(stripPrivateTags(42)).toBe(42);
  });

  it('passes booleans through unchanged', () => {
    expect(stripPrivateTags(true)).toBe(true);
  });

  it('passes null through unchanged', () => {
    expect(stripPrivateTags(null)).toBe(null);
  });

  it('passes undefined through unchanged', () => {
    expect(stripPrivateTags(undefined)).toBe(undefined);
  });

  it('passes through an object with mixed value types', () => {
    const input = { s: '<private>X</private>', n: 42, b: true, z: null };
    expect(stripPrivateTags(input)).toEqual({ s: '', n: 42, b: true, z: null });
  });
});

// ── Security: SECRET never leaks ────────────────────────────────────────────

describe('stripPrivateTags — security: no SECRET leakage', () => {
  it('SECRET=abc123 in private tag is fully removed', () => {
    const result = stripPrivateTags('safe <private>SECRET=abc123</private> safe');
    expect(result).not.toContain('SECRET');
    expect(result).not.toContain('abc123');
    expect(JSON.stringify(result)).not.toContain('SECRET=abc123');
  });

  it('SECRET in deeply nested structure is removed', () => {
    const input = { a: { b: { c: '<private>SECRET=abc123</private>' } } };
    const result = stripPrivateTags(input);
    expect(JSON.stringify(result)).not.toContain('SECRET=abc123');
  });

  it('multiple SECRET values in private tags are all removed', () => {
    const input = {
      x: '<private>SECRET_KEY=abc</private>',
      y: '<private>SECRET=abc123</private>',
    };
    const result = stripPrivateTags(input);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('abc');
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('stripPrivateTags — edge cases', () => {
  it('handles empty private section', () => {
    expect(stripPrivateTags('a <private></private> b')).toBe('a  b');
  });

  it('handles tags with only whitespace inside', () => {
    expect(stripPrivateTags('a <private>   </private> b')).toBe('a  b');
  });

  it('treats case-variant tags as literal text', () => {
    expect(stripPrivateTags('<Private>secret</Private>')).toBe('<Private>secret</Private>');
  });

  it('treats <private> without closing bracket as literal text', () => {
    expect(stripPrivateTags('before <private secret</private> after')).toBe('before <private secret</private> after');
  });

  it('handles string with only a close tag', () => {
    expect(stripPrivateTags('text </private> more')).toBe('text </private> more');
  });

  it('handles empty object', () => {
    expect(stripPrivateTags({})).toEqual({});
  });

  it('handles empty array', () => {
    expect(stripPrivateTags([])).toEqual([]);
  });

  it('preserves non-private markup-like content', () => {
    expect(stripPrivateTags('<div>not a private tag</div>')).toBe('<div>not a private tag</div>');
  });

  it('handles many consecutive opening tags without closing', () => {
    expect(stripPrivateTags('a <private><private><private>')).toBe('a ');
  });
});
