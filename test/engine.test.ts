import { describe, expect, test } from 'vitest';
import type { Chunk } from '../src/merge/chunk';
import { computeChunks, reassemble } from '../src/merge/engine';

const lines = (...ls: string[]) => ls.join('\n');

/** Convenience: describe each chunk as "kind@baseStart-baseEnd" for readable assertions. */
const shape = (chunks: Chunk[]) => chunks.map((c) => `${c.kind}@${c.base.start}-${c.base.end}`);

describe('computeChunks — classification', () => {
  test('identical inputs produce no chunks', () => {
    expect(computeChunks(lines('a', 'b', 'c'), lines('a', 'b', 'c'), lines('a', 'b', 'c'))).toEqual(
      [],
    );
  });

  test('a change on the left only is changedLeft', () => {
    const chunks = computeChunks(lines('a', 'b', 'c'), lines('a', 'B', 'c'), lines('a', 'b', 'c'));
    expect(shape(chunks)).toEqual(['changedLeft@1-2']);
    expect(chunks[0]?.leftSubtype).toBe('modified');
    expect(chunks[0]?.rightSubtype).toBe('none');
  });

  test('a change on the right only is changedRight', () => {
    const chunks = computeChunks(lines('a', 'b', 'c'), lines('a', 'b', 'c'), lines('a', 'B', 'c'));
    expect(shape(chunks)).toEqual(['changedRight@1-2']);
    expect(chunks[0]?.rightSubtype).toBe('modified');
  });

  test('the same change on both sides is bothIdentical, never a conflict', () => {
    const chunks = computeChunks(lines('a', 'b', 'c'), lines('a', 'B', 'c'), lines('a', 'B', 'c'));
    expect(shape(chunks)).toEqual(['bothIdentical@1-2']);
  });

  test('different changes to the same line are a conflict', () => {
    const chunks = computeChunks(lines('a', 'b', 'c'), lines('a', 'L', 'c'), lines('a', 'R', 'c'));
    expect(shape(chunks)).toEqual(['conflict@1-2']);
    expect(chunks[0]?.bothInserted).toBe(false);
  });

  test('changes to different lines stay separate chunks', () => {
    const chunks = computeChunks(
      lines('a', 'b', 'c', 'd'),
      lines('A', 'b', 'c', 'd'),
      lines('a', 'b', 'c', 'D'),
    );
    expect(shape(chunks)).toEqual(['changedLeft@0-1', 'changedRight@3-4']);
  });
});

describe('computeChunks — subtypes', () => {
  test('an added line is subtype added with an empty base range', () => {
    const chunks = computeChunks(lines('a', 'c'), lines('a', 'b', 'c'), lines('a', 'c'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe('changedLeft');
    expect(chunks[0]?.leftSubtype).toBe('added');
    expect(chunks[0]?.base.start).toBe(chunks[0]?.base.end);
  });

  test('a removed line is subtype deleted with an empty side range', () => {
    const chunks = computeChunks(lines('a', 'b', 'c'), lines('a', 'c'), lines('a', 'b', 'c'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.leftSubtype).toBe('deleted');
    expect(chunks[0]?.left.start).toBe(chunks[0]?.left.end);
  });
});

describe('computeChunks — insertions at the same anchor', () => {
  test('both sides inserting different text at one point conflicts and flags bothInserted', () => {
    const chunks = computeChunks(lines('a', 'z'), lines('a', 'L', 'z'), lines('a', 'R', 'z'));
    expect(shape(chunks)).toEqual(['conflict@1-1']);
    expect(chunks[0]?.bothInserted).toBe(true);
  });

  test('both sides inserting the same text at one point is bothIdentical', () => {
    const chunks = computeChunks(lines('a', 'z'), lines('a', 'X', 'z'), lines('a', 'X', 'z'));
    expect(shape(chunks)).toEqual(['bothIdentical@1-1']);
  });

  test('a modification and an insertion overlapping in base merge into one conflict', () => {
    const chunks = computeChunks(
      lines('a', 'b', 'z'),
      lines('a', 'B', 'z'),
      lines('a', 'b', 'N', 'z'),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe('conflict');
  });
});

describe('computeChunks — edge cases', () => {
  test('an empty base with both sides adding content conflicts as bothInserted', () => {
    const chunks = computeChunks('', lines('a'), lines('b'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe('conflict');
    expect(chunks[0]?.bothInserted).toBe(true);
  });

  test('a file emptied on one side is a deletion', () => {
    const chunks = computeChunks(lines('a', 'b'), '', lines('a', 'b'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe('changedLeft');
    expect(chunks[0]?.leftSubtype).toBe('deleted');
  });

  test('chunks are sorted and never overlap in any document', () => {
    const chunks = computeChunks(
      lines('a', 'b', 'c', 'd', 'e', 'f'),
      lines('A', 'b', 'c', 'D', 'e', 'f'),
      lines('a', 'b', 'C', 'd', 'e', 'F'),
    );
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      expect(curr.base.start).toBeGreaterThanOrEqual(prev.base.end);
      expect(curr.left.start).toBeGreaterThanOrEqual(prev.left.end);
      expect(curr.right.start).toBeGreaterThanOrEqual(prev.right.end);
    }
  });

  test('chunk ids are unique and sequential', () => {
    const chunks = computeChunks(lines('a', 'b', 'c'), lines('A', 'b', 'C'), lines('a', 'B', 'c'));
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => i));
  });
});

describe('reassemble — the correctness invariant', () => {
  const cases: Array<{ name: string; base: string; left: string; right: string }> = [
    {
      name: 'one-sided edits',
      base: lines('a', 'b', 'c'),
      left: lines('A', 'b', 'c'),
      right: lines('a', 'b', 'C'),
    },
    {
      name: 'conflicting edits',
      base: lines('a', 'b', 'c'),
      left: lines('a', 'L', 'c'),
      right: lines('a', 'R', 'c'),
    },
    {
      name: 'identical edits',
      base: lines('a', 'b'),
      left: lines('a', 'X'),
      right: lines('a', 'X'),
    },
    {
      name: 'insertions',
      base: lines('a', 'z'),
      left: lines('a', 'L1', 'L2', 'z'),
      right: lines('a', 'R', 'z'),
    },
    {
      name: 'deletions',
      base: lines('a', 'b', 'c', 'd'),
      left: lines('a', 'd'),
      right: lines('a', 'b', 'c'),
    },
    { name: 'empty base', base: '', left: lines('a', 'b'), right: lines('c') },
    { name: 'emptied left', base: lines('a', 'b'), left: '', right: lines('a', 'b', 'c') },
    { name: 'no common lines', base: lines('a'), left: lines('x'), right: lines('y') },
    {
      name: 'adjacent changes',
      base: lines('a', 'b', 'c'),
      left: lines('a', 'B', 'C'),
      right: lines('A', 'b', 'c'),
    },
    {
      name: 'trailing newline only on left',
      base: lines('a'),
      left: 'a\n',
      right: lines('a', 'b'),
    },
  ];

  test.each(cases)('taking every left side reproduces the left file ($name)', (c) => {
    const chunks = computeChunks(c.base, c.left, c.right);
    expect(reassemble(c.base, c.left, c.right, chunks, 'left')).toBe(c.left);
  });

  test.each(cases)('taking every right side reproduces the right file ($name)', (c) => {
    const chunks = computeChunks(c.base, c.left, c.right);
    expect(reassemble(c.base, c.left, c.right, chunks, 'right')).toBe(c.right);
  });

  test.each(cases)('taking no side reproduces the base file ($name)', (c) => {
    const chunks = computeChunks(c.base, c.left, c.right);
    expect(reassemble(c.base, c.left, c.right, chunks, 'base')).toBe(c.base);
  });
});
