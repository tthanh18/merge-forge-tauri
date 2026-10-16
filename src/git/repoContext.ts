import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gitText } from './gitCli';
import { refToBranchName } from './resolveOps';

/** The git operation that produced the current conflicts. */
export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'unknown';

export interface Operation {
  kind: OperationKind;
  /**
   * True when git's stage 2/3 are reversed relative to how a user thinks about the merge.
   *
   * A rebase replays your commits onto the upstream branch, so git's "ours" (stage 2) is
   * the *upstream* side and its "theirs" (stage 3) is *your* commit — the opposite of a
   * merge. Since the left pane always means "yours", the sides swap for rebase and
   * cherry-pick. (Verified against a real rebase in the fixture repo.)
   */
  swapPresentation: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a git-relative name such as `MERGE_HEAD` to an absolute location.
 * `--git-path` answers relative to the repo root (`.git/MERGE_HEAD`), so it has to be
 * re-anchored — resolving it against the *process* cwd would silently look elsewhere.
 */
async function gitPath(repoRoot: string, name: string): Promise<string> {
  return resolve(repoRoot, await gitText(repoRoot, ['rev-parse', '--git-path', name]));
}

/**
 * Works out which operation left the repo mid-conflict, and therefore how to label and
 * orient the panes. Checks rebase before merge: a rebase also writes MERGE_HEAD in some
 * git versions, so the more specific marker has to win.
 */
export async function detectOperation(repoRoot: string): Promise<Operation> {
  const [rebaseMerge, rebaseApply, cherryPick, mergeHead] = await Promise.all([
    gitPath(repoRoot, 'rebase-merge').then(exists),
    gitPath(repoRoot, 'rebase-apply').then(exists),
    gitPath(repoRoot, 'CHERRY_PICK_HEAD').then(exists),
    gitPath(repoRoot, 'MERGE_HEAD').then(exists),
  ]);

  if (rebaseMerge || rebaseApply) {
    return { kind: 'rebase', swapPresentation: true };
  }
  if (cherryPick) {
    return { kind: 'cherry-pick', swapPresentation: true };
  }
  if (mergeHead) {
    return { kind: 'merge', swapPresentation: false };
  }
  return { kind: 'unknown', swapPresentation: false };
}

/** Branch names for display: "Merging <theirs> into <yours>". */
export interface MergeBranches {
  yours: string;
  theirs: string;
}

async function tryGit(repoRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const value = await gitText(repoRoot, args);
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

async function readGitFile(repoRoot: string, name: string): Promise<string | undefined> {
  try {
    return (await readFile(await gitPath(repoRoot, name), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/**
 * Works out the two branch names involved in the current operation, for labels like
 * "Merging main into feature" and the pane headers.
 *
 * The wrinkle is rebase: HEAD is detached mid-rebase, so `branch --show-current` is
 * empty and your branch's name only exists in `.git/rebase-merge/head-name`. The other
 * side comes from resolving the `onto` commit back to a name. Every lookup degrades to a
 * generic label rather than failing — these strings are display-only.
 */
export async function getMergeBranches(repoRoot: string): Promise<MergeBranches> {
  const operation = await detectOperation(repoRoot);

  if (operation.kind === 'rebase') {
    const headName =
      (await readGitFile(repoRoot, 'rebase-merge/head-name')) ??
      (await readGitFile(repoRoot, 'rebase-apply/head-name'));
    const onto = await readGitFile(repoRoot, 'rebase-merge/onto');
    const ontoName = onto ? await tryGit(repoRoot, ['name-rev', '--name-only', onto]) : undefined;
    return {
      yours: headName ? refToBranchName(headName) : 'yours',
      theirs: ontoName ?? 'upstream',
    };
  }

  const current = await tryGit(repoRoot, ['branch', '--show-current']);
  const incomingRef = operation.kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'MERGE_HEAD';
  const incoming = await tryGit(repoRoot, ['name-rev', '--name-only', incomingRef]);
  return { yours: current ?? 'yours', theirs: incoming ?? 'theirs' };
}

/**
 * Finds the repository root containing `path`, or undefined when it is not in a repo.
 * The returned path is git's canonical root, which has symlinks resolved.
 */
export async function findRepoRoot(path: string): Promise<string | undefined> {
  let cwd = path;
  try {
    if (!(await stat(path)).isDirectory()) {
      cwd = dirname(path);
    }
  } catch {
    cwd = dirname(path);
  }
  try {
    return await gitText(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
}
