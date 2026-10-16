import type { Chunk, ChunkState, ChunkSubtype } from '../src/merge/chunk';
import type { WordRange } from '../src/merge/wordDiff';
import type { CenterRange } from './alignment';
import type { monaco } from './monaco';
import type { PaneName } from './panes';

/** Word-level emphasis for one chunk, per side pane. */
export interface ChunkWordRanges {
  left: WordRange[];
  right: WordRange[];
}

/** JetBrains colour scheme: blue modified, green added, gray deleted, red conflict. */
function classesFor(kind: 'mod' | 'add' | 'del' | 'conf', state: ChunkState): string[] {
  const classes = [`mf-${kind}`];
  if (state === 'ignored') {
    classes.push('mf-ignored');
  } else if (state !== 'initial') {
    classes.push('mf-resolved');
  }
  return classes;
}

function kindForSide(chunk: Chunk, subtype: ChunkSubtype): 'mod' | 'add' | 'del' | 'conf' | null {
  if (subtype === 'none') {
    return null;
  }
  if (chunk.kind === 'conflict') {
    return 'conf';
  }
  switch (subtype) {
    case 'added':
      return 'add';
    case 'deleted':
      return 'del';
    case 'modified':
      return 'mod';
  }
}

/**
 * Converts a 0-based half-open line range into a Monaco whole-line range.
 * An empty range (a pure insertion point) has nothing to paint.
 */
function toMonacoRange(range: { start: number; end: number }): monaco.IRange | null {
  if (range.end <= range.start) {
    return null;
  }
  return {
    startLineNumber: range.start + 1,
    startColumn: 1,
    endLineNumber: range.end,
    endColumn: Number.MAX_SAFE_INTEGER,
  };
}

/** Overview-ruler stripe colours per kind — the WebStorm scrollbar marks. */
const RULER_COLORS: Record<'mod' | 'add' | 'del' | 'conf', string> = {
  mod: 'rgba(58, 121, 189, 0.9)',
  add: 'rgba(98, 150, 85, 0.9)',
  del: 'rgba(128, 128, 128, 0.9)',
  conf: 'rgba(199, 84, 80, 0.95)',
};

// monaco.editor.OverviewRulerLane.Full — inlined so this module stays type-only on monaco.
const RULER_LANE_FULL = 7;

/**
 * The fill, ruler mark, and 1px top/bottom edges for one chunk range. The edges need
 * their own single-line decorations: a border on the range's class would draw on *every*
 * line of a multi-line chunk, not just its first and last.
 */
function decorationsFor(
  range: { start: number; end: number },
  kind: 'mod' | 'add' | 'del' | 'conf',
  state: ChunkState,
): monaco.editor.IModelDeltaDecoration[] {
  const monacoRange = toMonacoRange(range);
  if (!monacoRange) {
    return [];
  }
  const line = (lineNumber: number, className: string): monaco.editor.IModelDeltaDecoration => ({
    range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 },
    options: { isWholeLine: true, className },
  });
  return [
    {
      range: monacoRange,
      options: {
        isWholeLine: true,
        className: classesFor(kind, state).join(' '),
        linesDecorationsClassName: `mf-stripe mf-stripe-${kind}`,
        overviewRuler: { color: RULER_COLORS[kind], position: RULER_LANE_FULL },
      },
    },
    line(monacoRange.startLineNumber, `mf-edge-top mf-edge-${kind}`),
    line(monacoRange.endLineNumber, `mf-edge-bottom mf-edge-${kind}`),
  ];
}

/**
 * Repaints every chunk highlight from current state.
 *
 * The center pane is painted from live tracked ranges, not `chunk.base`, so highlights
 * follow the text after an accept or a manual edit.
 */
/** Navigation emphasis: the persistent current chunk and the transient arrival flash. */
export interface NavEmphasis {
  currentChunkId?: number | undefined;
  flashChunkId?: number | undefined;
  hoverChunkId?: number | undefined;
}

/**
 * How strongly a side's word marks should still read after a decision.
 *
 * Conflicts decide each side on its own (accepting left leaves right still on offer),
 * so a side that can still be accepted or dismissed keeps full-strength marks. Applied
 * sides dim, declined sides fade furthest; non-conflict chunks settle as one unit.
 */
function wordTier(chunk: Chunk, pane: 'left' | 'right'): 'live' | 'resolved' | 'ignored' {
  if (chunk.state === 'ignored') {
    return 'ignored';
  }
  if (chunk.state === 'manuallyEdited') {
    return 'resolved';
  }
  if (chunk.kind !== 'conflict') {
    return chunk.state === 'initial' ? 'live' : 'resolved';
  }
  const applied =
    pane === 'left'
      ? chunk.state === 'appliedLeft' || chunk.state === 'appliedBoth'
      : chunk.state === 'appliedRight' || chunk.state === 'appliedBoth';
  if (applied) {
    return 'resolved';
  }
  const dismissed = pane === 'left' ? chunk.dismissedLeft : chunk.dismissedRight;
  return dismissed ? 'ignored' : 'live';
}

export function renderDecorations(
  chunks: readonly Chunk[],
  centerRanges: ReadonlyMap<number, CenterRange>,
  collections: Record<PaneName, monaco.editor.IEditorDecorationsCollection>,
  wordRanges?: ReadonlyMap<number, ChunkWordRanges>,
  emphasis?: NavEmphasis,
): void {
  const byPane: Record<PaneName, monaco.editor.IModelDeltaDecoration[]> = {
    left: [],
    center: [],
    right: [],
  };

  const pushWords = (
    pane: 'left' | 'right',
    chunk: Chunk,
    ranges: readonly WordRange[] | undefined,
  ): void => {
    if (!ranges) {
      return;
    }
    const startLine = pane === 'left' ? chunk.left.start : chunk.right.start;
    const kind = chunk.kind === 'conflict' ? 'conf' : 'mod';
    // Keep the word marks after a decision too: once you accept one side you still
    // need to see exactly which words differ in the other, to blend the two by hand.
    // A still-undecided side keeps full strength; a settled side dims; a declined
    // side fades furthest (WebStorm dims, never deletes).
    const classes = [`mf-word`, `mf-word-${kind}`];
    const tier = wordTier(chunk, pane);
    if (tier === 'resolved') {
      classes.push('mf-word-resolved');
    } else if (tier === 'ignored') {
      classes.push('mf-word-ignored');
    }
    for (const range of ranges) {
      byPane[pane].push({
        range: {
          startLineNumber: startLine + range.line + 1,
          startColumn: range.startCol + 1,
          endLineNumber: startLine + range.line + 1,
          endColumn: range.endCol + 1,
        },
        options: { inlineClassName: classes.join(' ') },
      });
    }
  };

  // Extra whole-line classes for one chunk across every pane it appears in.
  const pushEmphasis = (
    chunk: Chunk,
    centerRange: CenterRange | undefined,
    className: string,
  ): void => {
    const paint = (pane: PaneName, range: { start: number; end: number }) => {
      const monacoRange = toMonacoRange(range);
      if (monacoRange) {
        byPane[pane].push({ range: monacoRange, options: { isWholeLine: true, className } });
      }
    };
    paint('left', chunk.left);
    paint('right', chunk.right);
    if (centerRange) {
      paint('center', centerRange);
    }
  };

  for (const chunk of chunks) {
    const leftKind = kindForSide(chunk, chunk.leftSubtype);
    if (leftKind) {
      byPane.left.push(...decorationsFor(chunk.left, leftKind, chunk.state));
    }
    const rightKind = kindForSide(chunk, chunk.rightSubtype);
    if (rightKind) {
      byPane.right.push(...decorationsFor(chunk.right, rightKind, chunk.state));
    }
    const words = wordRanges?.get(chunk.id);
    pushWords('left', chunk, words?.left);
    pushWords('right', chunk, words?.right);
    // The center shows the chunk's overall kind, since it holds the merged result.
    const centerKind = chunk.kind === 'conflict' ? 'conf' : 'mod';
    const centerRange = centerRanges.get(chunk.id);
    if (centerRange) {
      byPane.center.push(...decorationsFor(centerRange, centerKind, chunk.state));
    }
    if (chunk.id === emphasis?.currentChunkId) {
      pushEmphasis(chunk, centerRange, 'mf-current');
    }
    if (chunk.id === emphasis?.flashChunkId) {
      pushEmphasis(chunk, centerRange, 'mf-flash');
    }
    if (chunk.id === emphasis?.hoverChunkId) {
      pushEmphasis(chunk, centerRange, 'mf-hover');
    }
  }

  for (const name of ['left', 'center', 'right'] as const) {
    collections[name].set(byPane[name]);
  }
}
