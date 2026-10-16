import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { autoMerge, computeChunks } from '../src/merge/engine';

/**
 * Cross-checks the engine's conflict detection against real `git merge-file`.
 * A merge tool that disagrees with git about what conflicts is worse than useless,
 * so this pins the clustering rule to git's actual behavior rather than our reading of it.
 */

const dir = mkdtempSync(join(tmpdir(), 'merge-forge-parity-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `git merge-file`, returning whether it conflicted and the text it produced. */
function gitMerge(base: string, left: string, right: string): { conflicts: boolean; text: string } {
  const paths = {
    base: join(dir, 'base.txt'),
    left: join(dir, 'left.txt'),
    right: join(dir, 'right.txt'),
  };
  writeFileSync(paths.base, base);
  writeFileSync(paths.left, left);
  writeFileSync(paths.right, right);
  const args = ['merge-file', '-p', paths.left, paths.base, paths.right];
  try {
    const text = execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return { conflicts: false, text };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer };
    if (typeof err.status !== 'number' || err.status < 0) {
      throw error;
    }
    return { conflicts: err.status > 0, text: err.stdout?.toString() ?? '' };
  }
}

function engineConflicts(base: string, left: string, right: string): boolean {
  return computeChunks(base, left, right).some((chunk) => chunk.kind === 'conflict');
}

/** Deterministic PRNG so a failure is always reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}

/** Derives a side from base by randomly keeping, editing, deleting, or inserting lines. */
function mutate(baseLines: string[], random: () => number, tag: string): string {
  const out: string[] = [];
  for (const line of baseLines) {
    const roll = random();
    if (roll < 0.6) {
      out.push(line);
    } else if (roll < 0.8) {
      out.push(`${line}${tag}`);
    } else if (roll < 0.9) {
      out.push(`${tag}${out.length}`, line);
    }
    // remaining 10%: drop the line
  }
  return out.join('\n');
}

describe('engine agrees with git merge-file about conflicts', () => {
  const random = makeRandom(20260716);
  const cases: Array<{ base: string; left: string; right: string }> = [];
  for (let i = 0; i < 300; i++) {
    const size = 1 + Math.floor(random() * 8);
    const baseLines = Array.from({ length: size }, (_, n) => `line${n}`);
    cases.push({
      base: baseLines.join('\n'),
      left: mutate(baseLines, random, 'L'),
      right: mutate(baseLines, random, 'R'),
    });
  }

  const describeCase = (c: { base: string; left: string; right: string }, detail: string) =>
    `base=${JSON.stringify(c.base)} left=${JSON.stringify(c.left)} right=${JSON.stringify(c.right)} ${detail}`;

  // Each case spawns a real `git merge-file`, so these need more than the default budget.
  test('conflict detection matches git on 300 generated triples', { timeout: 60_000 }, () => {
    const mismatches = cases
      .filter(
        (c) =>
          engineConflicts(c.base, c.left, c.right) !== gitMerge(c.base, c.left, c.right).conflicts,
      )
      .map((c) => describeCase(c, `engine=${engineConflicts(c.base, c.left, c.right)}`));
    expect(mismatches).toEqual([]);
  });

  test(
    'auto-merge output matches git byte-for-byte when git merges cleanly',
    { timeout: 60_000 },
    () => {
      const mismatches: string[] = [];
      for (const c of cases) {
        const git = gitMerge(c.base, c.left, c.right);
        if (git.conflicts) {
          continue;
        }
        const ours = autoMerge(c.base, c.left, c.right, computeChunks(c.base, c.left, c.right));
        if (ours !== git.text) {
          mismatches.push(
            describeCase(c, `ours=${JSON.stringify(ours)} git=${JSON.stringify(git.text)}`),
          );
        }
      }
      expect(mismatches).toEqual([]);
    },
  );
});
