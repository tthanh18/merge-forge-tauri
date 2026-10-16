import { git, gitText } from './gitCli';

/**
 * The three index stages git records for a conflicted file. A missing stage is
 * meaningful, not an error:
 *  - no `base`: both sides added the file independently (there is no common ancestor)
 *  - no `ours` or `theirs`: one side deleted the file while the other modified it
 */
export interface Stages {
  base?: Buffer;
  ours?: Buffer;
  theirs?: Buffer;
}

const STAGE_NAMES = { 1: 'base', 2: 'ours', 3: 'theirs' } as const;

type StageNumber = keyof typeof STAGE_NAMES;

function isStageNumber(value: number): value is StageNumber {
  return value === 1 || value === 2 || value === 3;
}

/**
 * Reads whichever stages exist for a conflicted path.
 *
 * Stages are resolved to blob SHAs first and read by SHA rather than via `git show :N:path`,
 * so a missing stage is discovered up front instead of by parsing an error message, and
 * paths never round-trip through git's pathspec syntax.
 */
export async function readStages(repoRoot: string, relativePath: string): Promise<Stages> {
  const listing = await gitText(repoRoot, ['ls-files', '-u', '--', relativePath]);
  if (listing === '') {
    throw new Error(`${relativePath} is not conflicted (no stages in the index)`);
  }

  const shaByStage = new Map<StageNumber, string>();
  for (const line of listing.split('\n')) {
    // Format: "<mode> <sha> <stage>\t<path>"
    const match = /^\S+\s+(\S+)\s+(\d)\t/.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const stage = Number(match[2]);
    if (isStageNumber(stage)) {
      shaByStage.set(stage, match[1]);
    }
  }

  const stages: Stages = {};
  await Promise.all(
    [...shaByStage].map(async ([stage, sha]) => {
      stages[STAGE_NAMES[stage]] = await git(repoRoot, ['cat-file', 'blob', sha]);
    }),
  );
  return stages;
}
