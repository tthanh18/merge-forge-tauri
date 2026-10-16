import type { Chunk, ChunkAction, ChunkState, Side } from './chunk';
import { transition } from './chunk';
import { splitLines } from './engine';

/**
 * Decides what text a chunk should contain after an action — the pure half of applying a
 * gutter button. The webview turns these into Monaco edits; keeping the decision here
 * means the interesting logic is testable without an editor.
 */

/** Text a chunk holds for a given state, given the three documents. */
export interface ChunkTexts {
  base: string[];
  left: string[];
  right: string[];
}

export function chunkTexts(chunk: Chunk, base: string, left: string, right: string): ChunkTexts {
  return {
    base: splitLines(base).slice(chunk.base.start, chunk.base.end),
    left: splitLines(left).slice(chunk.left.start, chunk.left.end),
    right: splitLines(right).slice(chunk.right.start, chunk.right.end),
  };
}

/**
 * The lines a chunk should contain in the result for a given state.
 *
 * `appliedBoth` concatenates in left-then-right order, matching how JetBrains stacks the
 * two sides when you accept both — and the order git would show them in a conflict block.
 */
export function textForState(texts: ChunkTexts, state: ChunkState): string[] {
  switch (state) {
    case 'appliedLeft':
      return texts.left;
    case 'appliedRight':
      return texts.right;
    case 'appliedBoth':
      return [...texts.left, ...texts.right];
    case 'initial':
    case 'ignored':
    case 'manuallyEdited':
      // Both keep whatever the result already holds: base for a fresh chunk, and for
      // 'ignored' that is precisely the point — deliberately take neither side.
      return texts.base;
  }
}

/** A resolved action: the new state plus the lines the result should now hold. */
export interface Resolution {
  state: ChunkState;
  lines: string[];
}

/**
 * Applies an action to a chunk, or returns null when the action isn't offered.
 * `manualEdit` is excluded: the text comes from the user, not from us.
 */
export function resolveAction(
  chunk: Chunk,
  texts: ChunkTexts,
  action: Exclude<ChunkAction, 'manualEdit'>,
): Resolution | null {
  const next = transition(chunk.kind, chunk.state, action);
  if (next === null) {
    return null;
  }
  return { state: next, lines: textForState(texts, next) };
}

/** Whether a side's accept button should be shown for a chunk in its current state. */
export function canAccept(chunk: Chunk, side: Side): boolean {
  return (
    transition(chunk.kind, chunk.state, side === 'left' ? 'acceptLeft' : 'acceptRight') !== null
  );
}

export function canIgnore(chunk: Chunk): boolean {
  return transition(chunk.kind, chunk.state, 'ignore') !== null;
}

/**
 * The side each non-conflicting chunk should take for "Apply All Non-Conflicting Changes".
 * Conflicts are left alone — deciding those is the user's job.
 *
 * `only` restricts the sweep to one side, backing the left-only/right-only toolbar variants.
 */
export function nonConflictingAction(
  chunk: Chunk,
  only?: Side,
): Exclude<ChunkAction, 'manualEdit'> | null {
  if (chunk.state !== 'initial') {
    return null;
  }
  switch (chunk.kind) {
    case 'changedLeft':
      return only === 'right' ? null : 'acceptLeft';
    case 'changedRight':
      return only === 'left' ? null : 'acceptRight';
    case 'bothIdentical':
      // Identical on both sides, so either accept yields the same text.
      return only === 'right' ? 'acceptRight' : 'acceptLeft';
    case 'conflict':
      return null;
  }
}

/** What the gutter strips may offer for one chunk, per side. */
export interface SideControls {
  acceptLeft: boolean;
  acceptRight: boolean;
  ignoreLeft: boolean;
  ignoreRight: boolean;
}

const NOTHING: SideControls = {
  acceptLeft: false,
  acceptRight: false,
  ignoreLeft: false,
  ignoreRight: false,
};

/**
 * The single source of truth for which controls each strip shows.
 *
 * For conflicts, each side is its own decision: it keeps offering accept AND dismiss
 * until that side is applied into the result or explicitly dismissed — so taking the
 * right side leaves `»` and `×` alive on the left, the JetBrains behaviour. Ignored and
 * hand-edited chunks are settled outright and offer nothing anywhere.
 */
export function sideControls(chunk: Chunk): SideControls {
  if (chunk.state === 'ignored' || chunk.state === 'manuallyEdited') {
    return NOTHING;
  }

  if (chunk.kind === 'conflict') {
    const leftLive =
      chunk.state !== 'appliedLeft' && chunk.state !== 'appliedBoth' && !chunk.dismissedLeft;
    const rightLive =
      chunk.state !== 'appliedRight' && chunk.state !== 'appliedBoth' && !chunk.dismissedRight;
    return {
      acceptLeft: leftLive,
      acceptRight: rightLive,
      ignoreLeft: leftLive,
      ignoreRight: rightLive,
    };
  }

  // Non-conflict kinds are a single decision: everything shows while untouched,
  // nothing after.
  if (chunk.state !== 'initial') {
    return NOTHING;
  }
  return {
    acceptLeft: canAccept(chunk, 'left'),
    acceptRight: canAccept(chunk, 'right'),
    ignoreLeft: canAccept(chunk, 'left'),
    ignoreRight: canAccept(chunk, 'right'),
  };
}
