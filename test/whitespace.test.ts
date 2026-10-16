import { describe, expect, test } from 'vitest';
import { computeChunks, reassemble } from '../src/merge/engine';

const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

describe('whitespace modes', () => {
  // Left only re-indents line b; right genuinely changes line d.
  const base = lines('a', '  b', 'c', 'd', 'z');
  const left = lines('a', '    b', 'c', 'd', 'z');
  const right = lines('a', '  b', 'c', 'D', 'z');

  test("'exact' (the default) sees the indentation change", () => {
    const chunks = computeChunks(base, left, right);
    expect(chunks.map((c) => c.kind)).toEqual(['changedLeft', 'changedRight']);
  });

  test("'trim' ignores leading/trailing whitespace but not inner edits", () => {
    const chunks = computeChunks(base, left, right, { whitespace: 'trim' });
    expect(chunks.map((c) => c.kind)).toEqual(['changedRight']);
  });

  test("'trim' still sees whitespace changes inside a line", () => {
    const chunks = computeChunks(lines('a b'), lines('a  b'), lines('a b'), {
      whitespace: 'trim',
    });
    expect(chunks).toHaveLength(1);
  });

  test("'ignoreAll' ignores whitespace anywhere in the line", () => {
    const chunks = computeChunks(lines('a b'), lines('a  b'), lines('a b'), {
      whitespace: 'ignoreAll',
    });
    expect(chunks).toEqual([]);
  });

  test("'ignoreAll' still reports real text changes", () => {
    const chunks = computeChunks(lines('a b'), lines('a  c'), lines('a b'), {
      whitespace: 'ignoreAll',
    });
    expect(chunks.map((c) => c.kind)).toEqual(['changedLeft']);
  });

  test("'ignoreAllAndEmpty' additionally ignores added blank lines", () => {
    const withBlank = lines('a', '', 'z');
    const chunks = computeChunks(lines('a', 'z'), withBlank, lines('a', 'z'), {
      whitespace: 'ignoreAllAndEmpty',
    });
    expect(chunks).toEqual([]);
  });

  test("'ignoreAll' (without AndEmpty) still reports added blank lines", () => {
    const withBlank = lines('a', '', 'z');
    const chunks = computeChunks(lines('a', 'z'), withBlank, lines('a', 'z'), {
      whitespace: 'ignoreAll',
    });
    expect(chunks).toHaveLength(1);
  });

  test('sides equal modulo whitespace classify as bothIdentical, not conflict', () => {
    const chunks = computeChunks(
      lines('a', 'b', 'z'),
      lines('a', 'B ', 'z'),
      lines('a', 'B', 'z'),
      {
        whitespace: 'trim',
      },
    );
    expect(chunks.map((c) => c.kind)).toEqual(['bothIdentical']);
  });

  test('output text is never normalized — accepted bytes stay exact', () => {
    // Even under 'trim', taking the left side must reproduce the left bytes
    // (including its whitespace), because only comparison changes, never content.
    const chunks = computeChunks(base, left, right, { whitespace: 'trim' });
    const result = reassemble(base, left, right, chunks, 'right');
    expect(result).toBe(lines('a', '  b', 'c', 'D', 'z'));
  });

  test('mixed: whitespace-only and real changes in one file under trim', () => {
    const b = lines('a', ' b', 'c', 'd', 'e', 'z');
    const l = lines('a', 'b', 'c', 'REAL', 'e', 'z');
    const r = lines('a', ' b', 'c', 'd', 'e', 'z');
    const chunks = computeChunks(b, l, r, { whitespace: 'trim' });
    expect(chunks.map((c) => c.kind)).toEqual(['changedLeft']);
    expect(chunks[0]?.base).toEqual({ start: 3, end: 4 });
  });
});
