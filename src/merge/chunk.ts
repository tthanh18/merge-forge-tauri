/**
 * Chunk model and resolution state machine — pure, no `vscode` or DOM imports.
 * Bundled into both the extension host and the webview.
 */

/** Half-open line range `[start, end)`, zero-based. An empty range marks an insertion point. */
export interface LineRange {
  start: number;
  end: number;
}

/** Which sides changed relative to base, and whether they agree. */
export type ChunkKind = 'changedLeft' | 'changedRight' | 'bothIdentical' | 'conflict';

/** Per-side visual classification, driving the JetBrains color scheme. */
export type ChunkSubtype = 'added' | 'deleted' | 'modified' | 'none';

export type ChunkState =
  'initial' | 'appliedLeft' | 'appliedRight' | 'appliedBoth' | 'ignored' | 'manuallyEdited';

export type ChunkAction = 'acceptLeft' | 'acceptRight' | 'ignore' | 'manualEdit' | 'revert';

export type Side = 'left' | 'right';

export interface Chunk {
  id: number;
  kind: ChunkKind;
  /** True when both sides inserted at the same empty base range (metadata only). */
  bothInserted: boolean;
  /**
   * Per-side dismissal for conflicts: "I have seen this side's change and decided not to
   * take it." A conflict side keeps offering accept and dismiss until it is applied or
   * dismissed — matching JetBrains, where taking one side leaves the other side's
   * controls in place. Meaningless for non-conflict kinds.
   */
  dismissedLeft: boolean;
  dismissedRight: boolean;
  base: LineRange;
  left: LineRange;
  right: LineRange;
  leftSubtype: ChunkSubtype;
  rightSubtype: ChunkSubtype;
  state: ChunkState;
}

export function isEmptyRange(range: LineRange): boolean {
  return range.end <= range.start;
}

export function rangeLength(range: LineRange): number {
  return Math.max(0, range.end - range.start);
}

/** A chunk counts as resolved once the user has done anything deliberate to it. */
export function isResolved(state: ChunkState): boolean {
  return state !== 'initial';
}

/** True when this chunk still needs a decision before the merge is safe to apply. */
export function isUnresolvedConflict(chunk: Chunk): boolean {
  return chunk.kind === 'conflict' && chunk.state === 'initial';
}

/** The sides whose content is currently present in the result for this state. */
function appliedSides(state: ChunkState): ReadonlySet<Side> {
  switch (state) {
    case 'appliedLeft':
      return new Set<Side>(['left']);
    case 'appliedRight':
      return new Set<Side>(['right']);
    case 'appliedBoth':
      return new Set<Side>(['left', 'right']);
    default:
      return new Set<Side>();
  }
}

function sidesToState(sides: ReadonlySet<Side>): ChunkState {
  if (sides.has('left') && sides.has('right')) {
    return 'appliedBoth';
  }
  if (sides.has('left')) {
    return 'appliedLeft';
  }
  if (sides.has('right')) {
    return 'appliedRight';
  }
  return 'initial';
}

/** Whether `side` carries a change worth accepting for this kind of chunk. */
function kindAllowsSide(kind: ChunkKind, side: Side): boolean {
  switch (kind) {
    case 'changedLeft':
      return side === 'left';
    case 'changedRight':
      return side === 'right';
    case 'bothIdentical':
    case 'conflict':
      return true;
  }
}

function accept(kind: ChunkKind, state: ChunkState, side: Side): ChunkState | null {
  // An ignored chunk has to be reverted before it can take content again.
  if (state === 'ignored' || !kindAllowsSide(kind, side)) {
    return null;
  }
  const applied = appliedSides(state);
  if (applied.has(side)) {
    return null;
  }
  // Both sides are the same text here, so one accept settles the chunk entirely.
  if (kind === 'bothIdentical') {
    return 'appliedBoth';
  }
  return sidesToState(new Set([...applied, side]));
}

/**
 * Computes the next state for a chunk, or `null` when the action is not offered
 * (the UI hides the corresponding button in exactly those cases).
 */
export function transition(
  kind: ChunkKind,
  state: ChunkState,
  action: ChunkAction,
): ChunkState | null {
  switch (action) {
    case 'acceptLeft':
      return accept(kind, state, 'left');
    case 'acceptRight':
      return accept(kind, state, 'right');
    case 'ignore':
      return state === 'initial' ? 'ignored' : null;
    case 'manualEdit':
      return 'manuallyEdited';
    case 'revert':
      return state === 'initial' ? null : 'initial';
  }
}
