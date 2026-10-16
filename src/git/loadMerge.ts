import { basename, relative } from 'node:path';
import type { InitPayload } from '../protocol';
import { makeEolInfo, normalizeEol, type EolSetting } from '../merge/lineEndings';
import { detectOperation, getMergeBranches } from './repoContext';
import { readStages } from './stages';

/** Why a conflicted file cannot be opened in the three-pane editor. */
export type UnsupportedReason = 'deletedByThem' | 'deletedByUs' | 'binary' | 'tooLarge';

/** Above this per-side size the editor would ruin the session, not help it. */
export const MAX_MERGE_BYTES = 10 * 1024 * 1024;

/** git's own heuristic: a NUL byte in the leading bytes means binary. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Refuses content the three-pane editor cannot meaningfully merge: binary blobs
 * (checked first — a huge binary should say "binary") and giant files.
 */
export function contentGuard(stages: {
  ours?: Buffer;
  theirs?: Buffer;
  base?: Buffer;
}): UnsupportedReason | undefined {
  const present = [stages.ours, stages.theirs, stages.base].filter(
    (b): b is Buffer => b !== undefined,
  );
  if (present.some(looksBinary)) {
    return 'binary';
  }
  if (present.some((b) => b.length > MAX_MERGE_BYTES)) {
    return 'tooLarge';
  }
  return undefined;
}

export interface MergeInputs {
  payload: InitPayload;
  /** True when your side carried a UTF-8 BOM, so applying can put it back. */
  hadBom: boolean;
  /** Set when the file is a delete/modify conflict, which has no meaningful three panes. */
  unsupported?: UnsupportedReason;
}

/** UTF-8 BOM as decoded into a JS string. */
const BOM = '﻿';

/** Strips a leading BOM so it never reaches the diff as part of the first line. */
function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Reads a conflicted file's stages and shapes them into what the webview needs.
 *
 * Two things happen here that the webview must not have to think about:
 *  - rebase/cherry-pick swap git's stage 2/3 so the left pane always means "yours"
 *  - all three texts are LF-normalized, with the original EOL recorded for the write-back
 */
export async function loadMergeInputs(
  repoRoot: string,
  relativePath: string,
  eolSetting: EolSetting,
): Promise<MergeInputs> {
  const [stages, operation, branches] = await Promise.all([
    readStages(repoRoot, relativePath),
    detectOperation(repoRoot),
    getMergeBranches(repoRoot),
  ]);

  // git's stage 2 is "ours" and stage 3 is "theirs", but during a rebase those are the
  // upstream and your own commit respectively — flip them so "yours" stays on the left.
  const yours = operation.swapPresentation ? stages.theirs : stages.ours;
  const theirs = operation.swapPresentation ? stages.ours : stages.theirs;

  if (!yours) {
    return { payload: emptyPayload(relativePath), hadBom: false, unsupported: 'deletedByUs' };
  }
  if (!theirs) {
    return { payload: emptyPayload(relativePath), hadBom: false, unsupported: 'deletedByThem' };
  }

  const guarded = contentGuard({
    ours: yours,
    theirs,
    ...(stages.base ? { base: stages.base } : {}),
  });
  if (guarded) {
    return { payload: emptyPayload(relativePath), hadBom: false, unsupported: guarded };
  }

  const rawLeft = yours.toString('utf8');
  const rawRight = theirs.toString('utf8');
  // A both-added conflict has no ancestor; an empty base makes every line an insertion.
  const rawBase = stages.base?.toString('utf8') ?? '';

  // A BOM is file metadata, not content. Left in place it would attach to the first line
  // and make otherwise-identical first lines differ.
  const left = stripBom(rawLeft);
  const right = stripBom(rawRight);
  const base = stripBom(rawBase);

  return {
    hadBom: rawLeft.startsWith(BOM),
    payload: {
      filePath: relative(repoRoot, relativePath) || relativePath,
      languageId: 'plaintext',
      left: normalizeEol(left),
      base: normalizeEol(base),
      right: normalizeEol(right),
      // Pane headers render these as "Changes from <label>", matching JetBrains.
      labels: { left: branches.yours, right: branches.theirs },
      eol: makeEolInfo(left, base, right, eolSetting),
      settings: { autoApplyNonConflicting: false },
    },
  };
}

function emptyPayload(relativePath: string): InitPayload {
  return {
    filePath: basename(relativePath),
    languageId: 'plaintext',
    left: '',
    base: '',
    right: '',
    labels: { left: 'Yours', right: 'Theirs' },
    eol: { left: 'lf', base: 'lf', right: 'lf', conflict: false, suggested: 'lf' },
    settings: { autoApplyNonConflicting: false },
  };
}
