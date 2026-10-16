import { git, gitText } from './gitCli';

/** Lists the repo-relative paths of every unmerged file, newest state from the index. */
export async function listConflicted(repoRoot: string): Promise<string[]> {
  const output = await gitText(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z']);
  // -z separates with NUL, which keeps paths with newlines or unusual bytes intact.
  return output.split('\0').filter((path) => path !== '');
}

/** Stages the resolved file, which is how git marks a conflict as settled. */
export async function markResolved(repoRoot: string, relativePath: string): Promise<void> {
  await git(repoRoot, ['add', '--', relativePath]);
}
