import { execFileSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listConflicted, markResolved } from '../src/git/conflicts';
import { detectOperation, findRepoRoot } from '../src/git/repoContext';
import { readStages } from '../src/git/stages';

/**
 * Integration tests against real repositories built by scripts/make-conflict-repo.mjs.
 * The git layer's whole job is to match git's actual behavior, so mocking git here
 * would only test our assumptions about it.
 */

const scriptPath = fileURLToPath(new URL('../scripts/make-conflict-repo.mjs', import.meta.url));

/** Builds a fixture repo and returns its path. */
function makeFixture(...args: string[]): string {
  const output = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  const match = /^repo:\s+(.+)$/m.exec(output);
  if (!match?.[1]) {
    throw new Error(`could not parse repo path from fixture output:\n${output}`);
  }
  return match[1].trim();
}

let repo: string;
let rebaseRepo: string;

beforeAll(() => {
  repo = makeFixture();
  rebaseRepo = makeFixture('--rebase');
}, 60_000);

afterAll(() => {
  for (const dir of [repo, rebaseRepo]) {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('listConflicted', () => {
  test('lists every unmerged file', async () => {
    expect((await listConflicted(repo)).sort()).toEqual([
      'both-added.txt',
      'crlf.txt',
      'delete-modify.txt',
      'modify-modify.txt',
      'no-trailing-newline.txt',
    ]);
  });

  test('omits files that merged cleanly', async () => {
    const conflicted = await listConflicted(repo);
    expect(conflicted).not.toContain('one-sided.txt');
    expect(conflicted).not.toContain('identical-change.txt');
  });
});

describe('readStages', () => {
  test('reads all three stages of an ordinary modify/modify conflict', async () => {
    const stages = await readStages(repo, 'modify-modify.txt');
    expect(stages.base?.toString()).toBe('one\ntwo\nthree\n');
    expect(stages.ours?.toString()).toBe('one\nOURS two\nthree\n');
    expect(stages.theirs?.toString()).toBe('one\nTHEIRS two\nthree\n');
  });

  test('reports a both-added conflict as having no base stage', async () => {
    const stages = await readStages(repo, 'both-added.txt');
    expect(stages.base).toBeUndefined();
    expect(stages.ours?.toString()).toContain('ours line 1');
    expect(stages.theirs?.toString()).toContain('theirs line 1');
  });

  test('reports a delete/modify conflict as having no theirs stage', async () => {
    const stages = await readStages(repo, 'delete-modify.txt');
    expect(stages.base).toBeDefined();
    expect(stages.ours).toBeDefined();
    expect(stages.theirs).toBeUndefined();
  });

  test('preserves CRLF bytes exactly rather than normalizing them', async () => {
    const stages = await readStages(repo, 'crlf.txt');
    expect(stages.ours?.toString()).toBe('first\r\nOURS second\r\nthird\r\n');
    expect(stages.theirs?.toString()).toBe('first\nsecond\nTHEIRS third\n');
  });

  test('preserves a missing trailing newline', async () => {
    const stages = await readStages(repo, 'no-trailing-newline.txt');
    expect(stages.ours?.toString()).toBe('ours changed the last line');
    expect(stages.ours?.toString().endsWith('\n')).toBe(false);
  });

  test('rejects a path that is not conflicted', async () => {
    await expect(readStages(repo, 'one-sided.txt')).rejects.toThrow(/not conflicted|no stages/i);
  });
});

describe('detectOperation', () => {
  test('detects a merge and keeps the pane sides as-is', async () => {
    const op = await detectOperation(repo);
    expect(op.kind).toBe('merge');
    expect(op.swapPresentation).toBe(false);
  });

  test('detects a rebase and swaps which stage is shown as yours', async () => {
    const op = await detectOperation(rebaseRepo);
    expect(op.kind).toBe('rebase');
    expect(op.swapPresentation).toBe(true);
  });
});

describe('findRepoRoot', () => {
  // Resolve both paths to handle macOS symlinks and Git's forward slashes on Windows.
  test('resolves the root from a nested path', async () => {
    const root = await findRepoRoot(join(repo, 'modify-modify.txt'));
    if (root === undefined) throw new Error('Expected a repository root');
    expect(realpathSync(root)).toBe(realpathSync(repo));
  });

  test('returns undefined outside a repository', async () => {
    expect(await findRepoRoot('/')).toBeUndefined();
  });
});

describe('markResolved', () => {
  test('stages the file so git no longer reports it as unmerged', async () => {
    const scratch = makeFixture();
    try {
      expect(await listConflicted(scratch)).toContain('modify-modify.txt');
      await markResolved(scratch, 'modify-modify.txt');
      expect(await listConflicted(scratch)).not.toContain('modify-modify.txt');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
