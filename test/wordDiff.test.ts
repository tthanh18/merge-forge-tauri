import { describe, expect, test } from 'vitest';
import { wordHighlights } from '../src/merge/wordDiff';

/**
 * wordHighlights(baseLines, sideLines) → ranges of the *side* text that differ from
 * base, as { line, startCol, endCol } with 0-based line (relative to the chunk) and
 * 0-based half-open columns — the webview shifts them to the chunk's position.
 */
describe('wordHighlights', () => {
  test('highlights the one changed word', () => {
    const ranges = wordHighlights(['const a = 1;\n'], ['const b = 1;\n']);
    expect(ranges).toEqual([{ line: 0, startCol: 6, endCol: 7 }]);
  });

  test('highlights an appended word at the end of the line', () => {
    const ranges = wordHighlights(['return x\n'], ['return x + y\n']);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startCol).toBeGreaterThanOrEqual(8);
    expect(ranges[0]?.endCol).toBe(12);
  });

  test('an entirely added side (empty base) highlights nothing — the line colour suffices', () => {
    expect(wordHighlights([], ['new line\n'])).toEqual([]);
  });

  test('identical text highlights nothing', () => {
    expect(wordHighlights(['same\n'], ['same\n'])).toEqual([]);
  });

  test('spans multiple lines with correct per-line positions', () => {
    const base = ['alpha beta\n', 'gamma delta\n'];
    const side = ['alpha BETA\n', 'gamma delta!\n'];
    const ranges = wordHighlights(base, side);
    expect(ranges.some((r) => r.line === 0 && r.startCol === 6)).toBe(true);
    expect(ranges.some((r) => r.line === 1)).toBe(true);
    // No range may cross a line boundary — Monaco decorations are per-line here.
    for (const range of ranges) {
      const lineLength = side[range.line]!.replace(/\n$/, '').length;
      expect(range.endCol).toBeLessThanOrEqual(lineLength);
      expect(range.startCol).toBeLessThan(range.endCol);
    }
  });

  test('bails out on oversized chunks instead of burning the UI thread', () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}\n`);
    const changed = big.map((l, i) => (i % 2 ? l : l.toUpperCase()));
    expect(wordHighlights(big, changed)).toEqual([]);
  });
});
