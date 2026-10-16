import { diffWordsWithSpace } from 'diff';

/**
 * Word-level emphasis inside changed chunks — the "Highlight words" behaviour from
 * JetBrains. Pure module: the webview shifts these chunk-relative positions to
 * absolute editor positions and renders them as inline decorations.
 */

/** A highlighted span of the *side* text: 0-based line within the chunk, half-open cols. */
export interface WordRange {
  line: number;
  startCol: number;
  endCol: number;
}

/** Chunks past these sizes skip word diffing — the line colour alone has to do. */
const MAX_LINES = 200;
const MAX_CHARS = 10_000;

/**
 * Ranges of `sideLines` that differ from `baseLines` at word granularity.
 *
 * Wholly added or wholly deleted chunks return nothing: every word would highlight,
 * which is exactly what the chunk's line background already says.
 */
export function wordHighlights(
  baseLines: readonly string[],
  sideLines: readonly string[],
): WordRange[] {
  if (baseLines.length === 0 || sideLines.length === 0) {
    return [];
  }
  const baseText = baseLines.join('');
  const sideText = sideLines.join('');
  if (
    baseLines.length > MAX_LINES ||
    sideLines.length > MAX_LINES ||
    baseText.length > MAX_CHARS ||
    sideText.length > MAX_CHARS
  ) {
    return [];
  }

  // Character offset where each side line starts, for offset→(line, col) mapping.
  const lineStarts: number[] = [0];
  for (const line of sideLines) {
    lineStarts.push((lineStarts.at(-1) ?? 0) + line.length);
  }

  const ranges: WordRange[] = [];
  let offset = 0;
  for (const part of diffWordsWithSpace(baseText, sideText)) {
    if (part.removed) {
      continue; // absent from the side text, so there is nothing to paint there
    }
    if (part.added) {
      pushSplitByLine(ranges, offset, offset + part.value.length, sideLines, lineStarts);
    }
    offset += part.value.length;
  }
  return ranges;
}

/**
 * Splits one character range at line boundaries: Monaco inline decorations must not
 * cross lines, and the trailing newline itself is never worth highlighting.
 */
function pushSplitByLine(
  out: WordRange[],
  start: number,
  end: number,
  sideLines: readonly string[],
  lineStarts: readonly number[],
): void {
  for (let line = 0; line < sideLines.length; line++) {
    const lineStart = lineStarts[line]!;
    const contentEnd = lineStart + sideLines[line]!.replace(/\n$/, '').length;
    const from = Math.max(start, lineStart);
    const to = Math.min(end, contentEnd);
    if (from < to) {
      out.push({ line, startCol: from - lineStart, endCol: to - lineStart });
    }
  }
}
