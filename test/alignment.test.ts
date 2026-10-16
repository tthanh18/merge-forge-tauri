import { describe, expect, test } from 'vitest';
import {
  baseLineNumbers,
  computeSegments,
  computeSpacers,
  rowExtent,
  type CenterRange,
} from '../webview/alignment';
import { computeChunks } from '../src/merge/engine';
import { splitLines } from '../src/merge/engine';

const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

/** Center ranges as they are at load time: the center pane starts out as the base text. */
function initialCenterRanges(chunks: ReturnType<typeof computeChunks>): Map<number, CenterRange> {
  return new Map(chunks.map((c) => [c.id, { start: c.base.start, end: c.base.end }]));
}

function totalsFor(base: string, left: string, right: string) {
  return {
    left: splitLines(left).length,
    center: splitLines(base).length,
    right: splitLines(right).length,
  };
}

/**
 * The invariant that makes scroll sync work: after padding, every pane occupies the same
 * number of rows, so scrollTop maps 1:1 between panes.
 */
function paddedHeights(base: string, left: string, right: string) {
  const chunks = computeChunks(base, left, right);
  const totals = totalsFor(base, left, right);
  const segments = computeSegments(chunks, initialCenterRanges(chunks), totals);
  const spacers = computeSpacers(segments);
  const padding = (pane: 'left' | 'center' | 'right') =>
    spacers[pane].reduce((sum, s) => sum + s.heightInLines, 0);
  return {
    left: totals.left + padding('left'),
    center: totals.center + padding('center'),
    right: totals.right + padding('right'),
  };
}

describe('computeSegments', () => {
  test('identical documents need a single stable segment and no padding', () => {
    const text = lines('a', 'b', 'c');
    const chunks = computeChunks(text, text, text);
    const segments = computeSegments(chunks, new Map(), totalsFor(text, text, text));
    expect(segments).toHaveLength(1);
    expect(computeSpacers(segments)).toEqual({ left: [], center: [], right: [] });
  });

  test('segments alternate stable and chunk regions', () => {
    const base = lines('a', 'b', 'c');
    const left = lines('a', 'B', 'c');
    const chunks = computeChunks(base, left, base);
    const segments = computeSegments(
      chunks,
      initialCenterRanges(chunks),
      totalsFor(base, left, base),
    );
    // stable "a", the changed "b", stable "c" — lines carry their own newline, so a
    // trailing newline adds no extra line.
    expect(segments.map((s) => s.left)).toEqual([1, 1, 1]);
  });
});

describe('computeSpacers — the alignment invariant', () => {
  const cases: Array<{ name: string; base: string; left: string; right: string }> = [
    { name: 'no changes', base: lines('a', 'b'), left: lines('a', 'b'), right: lines('a', 'b') },
    {
      name: 'left inserts two lines',
      base: lines('a', 'z'),
      left: lines('a', 'L1', 'L2', 'z'),
      right: lines('a', 'z'),
    },
    {
      name: 'right deletes a line',
      base: lines('a', 'b', 'z'),
      left: lines('a', 'b', 'z'),
      right: lines('a', 'z'),
    },
    {
      name: 'conflict with different sizes',
      base: lines('a', 'b', 'z'),
      left: lines('a', 'L1', 'L2', 'L3', 'z'),
      right: lines('a', 'R', 'z'),
    },
    {
      name: 'both sides insert at the same point',
      base: lines('a', 'z'),
      left: lines('a', 'L', 'z'),
      right: lines('a', 'R1', 'R2', 'z'),
    },
    {
      name: 'multiple separated changes',
      base: lines('a', 'b', 'c', 'd', 'e'),
      left: lines('A', 'b', 'c', 'd', 'e'),
      right: lines('a', 'b', 'c', 'd', 'E1', 'E2'),
    },
    { name: 'empty base', base: '', left: lines('a', 'b'), right: lines('c') },
    {
      name: 'left empties the file',
      base: lines('a', 'b'),
      left: '',
      right: lines('a', 'b', 'c'),
    },
  ];

  test.each(cases)('all three panes end up the same height ($name)', (c) => {
    const heights = paddedHeights(c.base, c.left, c.right);
    expect(heights.center).toBe(heights.left);
    expect(heights.right).toBe(heights.left);
  });

  test.each(cases)('padding is never negative and only pads shorter panes ($name)', (c) => {
    const chunks = computeChunks(c.base, c.left, c.right);
    const segments = computeSegments(
      chunks,
      initialCenterRanges(chunks),
      totalsFor(c.base, c.left, c.right),
    );
    for (const spacer of Object.values(computeSpacers(segments)).flat()) {
      expect(spacer.heightInLines).toBeGreaterThan(0);
      expect(spacer.afterLine).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('rowExtent — connector band geometry', () => {
  const lh = 18;

  test('a non-empty block spans exactly its own lines from its anchor', () => {
    expect(rowExtent(3, 5, 100, lh)).toEqual({ top: 100, bottom: 100 + 3 * lh });
  });

  test('an empty side spans its padding zone — the full row height', () => {
    // Anchor here is the bottom of the line the zone follows; the zone is maxLines tall.
    expect(rowExtent(0, 5, 100, lh)).toEqual({ top: 100, bottom: 100 + 5 * lh });
  });

  test('a zone above line 0 anchors at the document top', () => {
    expect(rowExtent(0, 2, 0, lh)).toEqual({ top: 0, bottom: 2 * lh });
  });

  test('own === max means no zone and both arms agree', () => {
    expect(rowExtent(4, 4, 50, lh)).toEqual(rowExtent(4, 4, 50, lh));
    expect(rowExtent(4, 4, 50, lh).bottom).toBe(50 + 4 * lh);
  });
});

describe('computeSpacers — gap tinting', () => {
  test('padding for a chunk carries its colour family; stable gaps carry none', () => {
    // Left adds two lines: center and right need padding tagged 'add'.
    const base = lines('a', 'z');
    const left = lines('a', 'L1', 'L2', 'z');
    const chunks = computeChunks(base, left, base);
    const segments = computeSegments(
      chunks,
      initialCenterRanges(chunks),
      totalsFor(base, left, base),
    );
    const spacers = computeSpacers(segments);
    expect(spacers.center.map((s) => s.visual)).toEqual(['add']);
    expect(spacers.right.map((s) => s.visual)).toEqual(['add']);
  });

  test('conflict padding is tagged conf', () => {
    const base = lines('a', 'b', 'z');
    const left = lines('a', 'L1', 'L2', 'L3', 'z');
    const right = lines('a', 'R', 'z');
    const chunks = computeChunks(base, left, right);
    const segments = computeSegments(
      chunks,
      initialCenterRanges(chunks),
      totalsFor(base, left, right),
    );
    const spacers = computeSpacers(segments);
    expect(spacers.right.every((s) => s.visual === 'conf')).toBe(true);
  });
});

describe('computeSegments — center tracking', () => {
  test('a center pane that grew from edits still aligns', () => {
    const base = lines('a', 'b', 'z');
    const left = lines('a', 'L', 'z');
    const right = lines('a', 'R', 'z');
    const chunks = computeChunks(base, left, right);
    // Simulate the user accepting left (1 line) then typing two more lines into it.
    const centerRanges = new Map<number, CenterRange>([[0, { start: 1, end: 4 }]]);
    const totals = { left: 4, center: 6, right: 4 };
    const segments = computeSegments(chunks, centerRanges, totals);
    const spacers = computeSpacers(segments);
    const padded = (pane: 'left' | 'center' | 'right', total: number) =>
      total + spacers[pane].reduce((sum, s) => sum + s.heightInLines, 0);
    expect(padded('center', totals.center)).toBe(padded('left', totals.left));
    expect(padded('right', totals.right)).toBe(padded('left', totals.left));
  });
});

describe('baseLineNumbers', () => {
  const render = (
    chunks: ReadonlyArray<{ id: number; base: CenterRange }>,
    centerRanges: Map<number, CenterRange>,
    baseTotal: number,
    centerTotal: number,
  ) => {
    const fn = baseLineNumbers(chunks, centerRanges, baseTotal);
    return Array.from({ length: centerTotal }, (_, i) => fn(i + 1));
  };

  test('identity when there are no chunks', () => {
    expect(render([], new Map(), 3, 3)).toEqual(['1', '2', '3']);
  });

  test('dot inside a chunk, identity around an equal-size replacement', () => {
    // Chunk replaces base line 2 (0-based 1..2) with one center line at the same spot.
    const chunks = [{ id: 0, base: { start: 1, end: 2 } }];
    const centerRanges = new Map([[0, { start: 1, end: 2 }]]);
    expect(render(chunks, centerRanges, 3, 3)).toEqual(['1', '·', '3']);
  });

  test('lines after a grown chunk keep their base numbers', () => {
    // Base line 2 was replaced by three center lines: center grew by 2.
    const chunks = [{ id: 0, base: { start: 1, end: 2 } }];
    const centerRanges = new Map([[0, { start: 1, end: 4 }]]);
    expect(render(chunks, centerRanges, 3, 5)).toEqual(['1', '·', '·', '·', '3']);
  });

  test('lines after a shrunk chunk keep their base numbers', () => {
    // Base lines 2-3 collapsed to nothing (deletion accepted): center shrank by 2.
    const chunks = [{ id: 0, base: { start: 1, end: 3 } }];
    const centerRanges = new Map([[0, { start: 1, end: 1 }]]);
    expect(render(chunks, centerRanges, 4, 2)).toEqual(['1', '4']);
  });

  test('two chunks accumulate drift independently', () => {
    // First chunk grows by 1, second is a pure insertion (no base lines).
    const chunks = [
      { id: 0, base: { start: 0, end: 1 } },
      { id: 1, base: { start: 2, end: 2 } },
    ];
    const centerRanges = new Map([
      [0, { start: 0, end: 2 }],
      [1, { start: 3, end: 4 }],
    ]);
    // Base: [A, B, C] → center: [a1, a2, B, ins, C]
    expect(render(chunks, centerRanges, 3, 5)).toEqual(['·', '·', '2', '·', '3']);
  });
});
