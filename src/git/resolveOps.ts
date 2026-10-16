import { git } from './gitCli';
import type { OperationKind } from './repoContext';

/**
 * Whole-file conflict resolution — the operations behind the Conflicts dialog's
 * Accept Yours / Accept Theirs buttons and the status cluster's abort.
 */

/** How one side of a conflict relates to the common ancestor, as shown in the dialog. */
export type SideStatus = 'Modified' | 'Deleted' | 'Added';

export interface ConflictStatus {
  path: string;
  yours: SideStatus;
  theirs: SideStatus;
}

/**
 * Classifies every conflicted path from a single `ls-files -u` pass.
 * A missing stage 2/3 means that side deleted the file; a missing stage 1 means there is
 * no common ancestor, i.e. both sides added it.
 */
export async function listConflictStatuses(repoRoot: string): Promise<ConflictStatus[]> {
  const output = (await git(repoRoot, ['ls-files', '-u', '-z'])).toString('utf8');
  const stagesByPath = new Map<string, Set<number>>();
  for (const entry of output.split('\0')) {
    // Format: "<mode> <sha> <stage>\t<path>"
    const match = /^\S+\s+\S+\s+(\d)\t(.+)$/s.exec(entry);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const stages = stagesByPath.get(match[2]) ?? new Set<number>();
    stages.add(Number(match[1]));
    stagesByPath.set(match[2], stages);
  }

  return [...stagesByPath].map(([path, stages]) => {
    const hasBase = stages.has(1);
    const statusOf = (stage: number): SideStatus =>
      stages.has(stage) ? (hasBase ? 'Modified' : 'Added') : 'Deleted';
    return { path, yours: statusOf(2), theirs: statusOf(3) };
  });
}

/** The side as the user sees it; mapping to git's stage side happens below. */
export type PresentationSide = 'yours' | 'theirs';

/**
 * Resolves whole files by taking one side, the way JetBrains' Accept Yours/Theirs does.
 *
 * `swapPresentation` mirrors `loadMerge.ts`: during a rebase or cherry-pick, git's
 * `--ours` is the *upstream* side, so the user's "yours" is git's `--theirs`. Getting
 * this wrong silently resolves every file to the opposite side — the rebase fixture
 * test pins the correct direction.
 *
 * A side that deleted the file (its stage is missing) resolves by deleting: `checkout
 * --ours/--theirs` errors on a missing stage, and `git rm` both removes the file and
 * settles the conflict in the index.
 */
export async function acceptSide(
  repoRoot: string,
  paths: readonly string[],
  side: PresentationSide,
  swapPresentation: boolean,
): Promise<void> {
  const gitSide = (side === 'yours') !== swapPresentation ? '--ours' : '--theirs';
  const stageToKeep = gitSide === '--ours' ? 2 : 3;
  const statuses = await listConflictStatuses(repoRoot);
  const stagesPresent = new Map(statuses.map((s) => [s.path, s]));

  for (const path of paths) {
    const status = stagesPresent.get(path);
    if (!status) {
      continue; // already resolved (e.g. by a concurrent action) — nothing to do
    }
    const keptSideDeleted =
      (stageToKeep === 2 && status.yours === 'Deleted') ||
      (stageToKeep === 3 && status.theirs === 'Deleted');
    if (keptSideDeleted) {
      await git(repoRoot, ['rm', '-q', '--', path]);
    } else {
      await git(repoRoot, ['checkout', gitSide, '--', path]);
      await git(repoRoot, ['add', '--', path]);
    }
  }
}

/** Aborts the in-flight operation, restoring the pre-merge working tree. */
export async function abortOperation(repoRoot: string, kind: OperationKind): Promise<void> {
  switch (kind) {
    case 'merge':
      await git(repoRoot, ['merge', '--abort']);
      break;
    case 'rebase':
      await git(repoRoot, ['rebase', '--abort']);
      break;
    case 'cherry-pick':
      await git(repoRoot, ['cherry-pick', '--abort']);
      break;
    case 'unknown':
      throw new Error('no merge, rebase, or cherry-pick is in progress');
  }
}

/** Strips a full ref down to a display name: refs/heads/main → main. */
export function refToBranchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').trim();
}
