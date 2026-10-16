import { diffArrays } from 'diff';
import type { Chunk, ChunkKind, ChunkSubtype, LineRange, Side } from './chunk';
import { isEmptyRange } from './chunk';

/**
 * Splits LF-normalized text into lines that keep their trailing newline, so that
 * `joinLines(splitLines(x)) === x` for every input and an empty file has zero lines.
 *
 * The terminator has to stay attached to the line: git compares lines *with* their
 * newline, which makes `"x"` at end-of-file a different line from `"x\n"`. Splitting on
 * `\n` instead would silently mis-diff every file that lacks a trailing newline, and
 * disagree with git about what conflicts (verified by the git-parity test).
 */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('');
}

/**
 * How lines are *compared* — never how they are stored or written. Output text always
 * keeps its exact bytes; these modes only decide which differences count as changes.
 */
export type WhitespaceMode = 'exact' | 'trim' | 'ignoreAll' | 'ignoreAllAndEmpty';

export interface ComputeOptions {
  whitespace?: WhitespaceMode;
}

/** Reduces a line to its comparison key for the given mode. */
function lineKey(line: string, mode: WhitespaceMode): string {
  switch (mode) {
    case 'exact':
      return line;
    case 'trim':
      // Also swallows the terminator, so a trailing-newline difference is whitespace too.
      return line.trim();
    case 'ignoreAll':
    case 'ignoreAllAndEmpty':
      return line.replace(/\s+/g, '');
  }
}

/** A contiguous region that differs between base and one side. */
interface Hunk {
  base: LineRange;
  side: LineRange;
}

interface TaggedHunk {
  side: Side;
  hunk: Hunk;
}

interface Cluster {
  baseStart: number;
  baseEnd: number;
  members: TaggedHunk[];
}

/**
 * Reduces a line diff to hunks. Consecutive removed/added runs collapse into a single
 * hunk, so a replaced line is one hunk rather than a delete plus an insert.
 */
function diffHunks(
  baseLines: readonly string[],
  sideLines: readonly string[],
  mode: WhitespaceMode,
): Hunk[] {
  const hunks: Hunk[] = [];
  let baseIdx = 0;
  let sideIdx = 0;
  let pending: Hunk | null = null;

  const changes =
    mode === 'exact'
      ? diffArrays(baseLines as string[], sideLines as string[])
      : diffArrays(baseLines as string[], sideLines as string[], {
          comparator: (a, b) => lineKey(a, mode) === lineKey(b, mode),
        });

  for (const change of changes) {
    const count = change.value.length;
    if (!change.added && !change.removed) {
      if (pending) {
        hunks.push(pending);
        pending = null;
      }
      baseIdx += count;
      sideIdx += count;
      continue;
    }
    pending ??= {
      base: { start: baseIdx, end: baseIdx },
      side: { start: sideIdx, end: sideIdx },
    };
    if (change.removed) {
      baseIdx += count;
      pending.base.end = baseIdx;
    } else {
      sideIdx += count;
      pending.side.end = sideIdx;
    }
  }
  if (pending) {
    hunks.push(pending);
  }
  if (mode === 'ignoreAllAndEmpty') {
    // A hunk whose every involved line is blank (after stripping) is pure blank-line
    // noise; dropping it here means it never reaches clustering or classification.
    return hunks.filter((hunk) => {
      const blank = (line: string) => lineKey(line, mode) === '';
      const baseBlank = baseLines.slice(hunk.base.start, hunk.base.end).every(blank);
      const sideBlank = sideLines.slice(hunk.side.start, hunk.side.end).every(blank);
      return !(baseBlank && sideBlank);
    });
  }
  return hunks;
}

/**
 * Groups hunks whose base intervals overlap *or touch* into one cluster.
 *
 * Touching matters: when one side rewrites base line 5 and the other inserts at the
 * boundary right after it, the base intervals are `[5,6)` and `[6,6)` — disjoint as
 * half-open intervals, yet git reports a conflict. Requiring at least one stable base
 * line between clusters reproduces git's behavior exactly (verified against
 * `git merge-file` for the overlap, touch, and gap cases).
 */
function clusterHunks(leftHunks: readonly Hunk[], rightHunks: readonly Hunk[]): Cluster[] {
  const tagged: TaggedHunk[] = [
    ...leftHunks.map((hunk): TaggedHunk => ({ side: 'left', hunk })),
    ...rightHunks.map((hunk): TaggedHunk => ({ side: 'right', hunk })),
  ].sort((a, b) => a.hunk.base.start - b.hunk.base.start || a.hunk.base.end - b.hunk.base.end);

  const clusters: Cluster[] = [];
  let current: Cluster | null = null;
  for (const entry of tagged) {
    // Sorted by base.start, so a closed-interval intersection reduces to this one test.
    if (current && entry.hunk.base.start <= current.baseEnd) {
      current.members.push(entry);
      current.baseEnd = Math.max(current.baseEnd, entry.hunk.base.end);
    } else {
      if (current) {
        clusters.push(current);
      }
      current = {
        baseStart: entry.hunk.base.start,
        baseEnd: entry.hunk.base.end,
        members: [entry],
      };
    }
  }
  if (current) {
    clusters.push(current);
  }
  return clusters;
}

/** How many lines this hunk adds to (or removes from) its side relative to base. */
function hunkDelta(hunk: Hunk): number {
  return hunk.side.end - hunk.side.start - (hunk.base.end - hunk.base.start);
}

function slice(lines: readonly string[], range: LineRange): string[] {
  return lines.slice(range.start, range.end);
}

function sameLines(a: readonly string[], b: readonly string[], mode: WhitespaceMode): boolean {
  return (
    a.length === b.length && a.every((line, i) => lineKey(line, mode) === lineKey(b[i]!, mode))
  );
}

function subtypeOf(changed: boolean, base: LineRange, side: LineRange): ChunkSubtype {
  if (!changed) {
    return 'none';
  }
  if (isEmptyRange(base)) {
    return 'added';
  }
  if (isEmptyRange(side)) {
    return 'deleted';
  }
  return 'modified';
}

function kindOf(
  changedLeft: boolean,
  changedRight: boolean,
  leftSlice: readonly string[],
  rightSlice: readonly string[],
  mode: WhitespaceMode,
): ChunkKind {
  if (changedLeft && !changedRight) {
    return 'changedLeft';
  }
  if (changedRight && !changedLeft) {
    return 'changedRight';
  }
  // Sides equal under the active mode merge cleanly; taking either yields that side's
  // exact bytes (left wins by convention when they differ only in whitespace).
  return sameLines(leftSlice, rightSlice, mode) ? 'bothIdentical' : 'conflict';
}

/**
 * Computes the aligned three-way chunks for a merge. Inputs must be LF-normalized.
 *
 * Each chunk names the same region in all three documents, so a chunk's `left` range is
 * meaningful even when only the right side changed — the unchanged side simply maps
 * through the running line offset.
 */
export function computeChunks(
  base: string,
  left: string,
  right: string,
  options?: ComputeOptions,
): Chunk[] {
  const mode = options?.whitespace ?? 'exact';
  const baseLines = splitLines(base);
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);

  const leftHunks = diffHunks(baseLines, leftLines, mode);
  const rightHunks = diffHunks(baseLines, rightLines, mode);
  const clusters = clusterHunks(leftHunks, rightHunks);

  const chunks: Chunk[] = [];
  let leftOffset = 0;
  let rightOffset = 0;

  for (const cluster of clusters) {
    const baseRange: LineRange = { start: cluster.baseStart, end: cluster.baseEnd };
    const leftMembers = cluster.members.filter((m) => m.side === 'left');
    const rightMembers = cluster.members.filter((m) => m.side === 'right');
    const leftDelta = leftMembers.reduce((sum, m) => sum + hunkDelta(m.hunk), 0);
    const rightDelta = rightMembers.reduce((sum, m) => sum + hunkDelta(m.hunk), 0);

    // Cluster boundaries are stable positions, so mapping them through the running
    // offset is exact; the side range then absorbs this cluster's own delta.
    const leftRange: LineRange = {
      start: baseRange.start + leftOffset,
      end: baseRange.end + leftOffset + leftDelta,
    };
    const rightRange: LineRange = {
      start: baseRange.start + rightOffset,
      end: baseRange.end + rightOffset + rightDelta,
    };
    leftOffset += leftDelta;
    rightOffset += rightDelta;

    const changedLeft = leftMembers.length > 0;
    const changedRight = rightMembers.length > 0;
    const leftSlice = slice(leftLines, leftRange);
    const rightSlice = slice(rightLines, rightRange);
    const kind = kindOf(changedLeft, changedRight, leftSlice, rightSlice, mode);

    chunks.push({
      id: chunks.length,
      kind,
      bothInserted:
        kind === 'conflict' &&
        isEmptyRange(baseRange) &&
        !isEmptyRange(leftRange) &&
        !isEmptyRange(rightRange),
      dismissedLeft: false,
      dismissedRight: false,
      base: baseRange,
      left: leftRange,
      right: rightRange,
      leftSubtype: subtypeOf(changedLeft, baseRange, leftRange),
      rightSubtype: subtypeOf(changedRight, baseRange, rightRange),
      state: 'initial',
    });
  }

  return chunks;
}

/** Which side's content a chunk contributes to a rebuilt document. */
type ChunkPick = Side | 'base';

/** Rebuilds a document, asking `pick` which side each chunk should contribute. */
function rebuild(
  base: string,
  left: string,
  right: string,
  chunks: readonly Chunk[],
  pick: (chunk: Chunk) => ChunkPick,
): string {
  const baseLines = splitLines(base);
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const result: string[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    // Regions between chunks are identical in all three documents, so base is authoritative.
    result.push(...baseLines.slice(cursor, chunk.base.start));
    switch (pick(chunk)) {
      case 'left':
        result.push(...slice(leftLines, chunk.left));
        break;
      case 'right':
        result.push(...slice(rightLines, chunk.right));
        break;
      case 'base':
        result.push(...slice(baseLines, chunk.base));
        break;
    }
    cursor = chunk.base.end;
  }
  result.push(...baseLines.slice(cursor));
  return joinLines(result);
}

/**
 * Resolves every chunk that only one side touched (or that both sides changed the same
 * way), leaving true conflicts at their base content. This is what the toolbar's
 * "Apply All Non-Conflicting Changes" produces.
 *
 * When there are no conflicts the output matches `git merge-file` byte-for-byte, which
 * the git-parity test enforces.
 */
export function autoMerge(
  base: string,
  left: string,
  right: string,
  chunks: readonly Chunk[],
): string {
  return rebuild(base, left, right, chunks, (chunk) => {
    switch (chunk.kind) {
      case 'changedLeft':
      case 'bothIdentical':
        return 'left';
      case 'changedRight':
        return 'right';
      case 'conflict':
        return 'base';
    }
  });
}

/**
 * Rebuilds a document by taking every chunk from one side (or leaving base everywhere).
 *
 * This is the engine's correctness contract: taking every left chunk must reproduce the
 * left file byte-for-byte, and likewise for right and base. Regions between chunks are
 * identical in all three documents, so they are always read from base.
 */
export function reassemble(
  base: string,
  left: string,
  right: string,
  chunks: readonly Chunk[],
  mode: ChunkPick,
): string {
  return rebuild(base, left, right, chunks, () => mode);
}
