import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { listConflicted } from '../src/git/conflicts';
import { getMergeBranches } from '../src/git/repoContext';
import { abortOperation, acceptSide, listConflictStatuses } from '../src/git/resolveOps';

const scriptPath = fileURLToPath(new URL('../scripts/make-conflict-repo.mjs', import.meta.url));
const created: string[] = [];

function fixture(...args: string[]): string {
  const output = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  const path = /^repo:\s+(.+)$/m.exec(output)?.[1]?.trim();
  if (!path) {
    throw new Error(`could not parse repo path:\n${output}`);
  }
  created.push(path);
  return path;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getMergeBranches', () => {
  test('during a merge, names the current and incoming branches', async () => {
    const branches = await getMergeBranches(fixture());
    expect(branches).toEqual({ yours: 'main', theirs: 'feature' });
  });

  test('during a rebase, still names YOUR branch despite the detached HEAD', async () => {
    // `git branch --show-current` is empty mid-rebase; the name must come from
    // .git/rebase-merge/head-name, and "theirs" from the onto commit.
    const branches = await getMergeBranches(fixture('--rebase'));
    expect(branches).toEqual({ yours: 'main', theirs: 'feature' });
  });
});

describe('listConflictStatuses', () => {
  test('classifies each conflict shape from the index stages', async () => {
    const statuses = await listConflictStatuses(fixture());
    const byPath = new Map(statuses.map((s) => [s.path, s]));
    expect(byPath.get('modify-modify.txt')).toMatchObject({
      yours: 'Modified',
      theirs: 'Modified',
    });
    expect(byPath.get('both-added.txt')).toMatchObject({ yours: 'Added', theirs: 'Added' });
    // The fixture's feature branch deleted the file main modified.
    expect(byPath.get('delete-modify.txt')).toMatchObject({ yours: 'Modified', theirs: 'Deleted' });
    expect(statuses).toHaveLength(5);
  });
});

describe('acceptSide', () => {
  test('accept yours keeps your bytes and marks the file resolved', async () => {
    const repo = fixture();
    await acceptSide(repo, ['modify-modify.txt'], 'yours', false);
    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nOURS two\nthree\n');
    expect(await listConflicted(repo)).not.toContain('modify-modify.txt');
  }, 30_000);

  test('accept theirs takes the incoming bytes', async () => {
    const repo = fixture();
    await acceptSide(repo, ['modify-modify.txt'], 'theirs', false);
    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nTHEIRS two\nthree\n');
  }, 30_000);

  test('resolves several files in one call', async () => {
    const repo = fixture();
    await acceptSide(repo, ['modify-modify.txt', 'crlf.txt'], 'yours', false);
    const remaining = await listConflicted(repo);
    expect(remaining).not.toContain('modify-modify.txt');
    expect(remaining).not.toContain('crlf.txt');
  }, 30_000);

  test('accepting the deleting side of a delete/modify removes the file', async () => {
    const repo = fixture();
    // Theirs (feature) deleted delete-modify.txt; accepting theirs must delete it.
    await acceptSide(repo, ['delete-modify.txt'], 'theirs', false);
    expect(existsSync(join(repo, 'delete-modify.txt'))).toBe(false);
    expect(await listConflicted(repo)).not.toContain('delete-modify.txt');
  }, 30_000);

  test('accepting the modifying side of a delete/modify keeps the file', async () => {
    const repo = fixture();
    await acceptSide(repo, ['delete-modify.txt'], 'yours', false);
    expect(readFileSync(join(repo, 'delete-modify.txt'), 'utf8')).toBe(
      'modified instead of deleted\n',
    );
    expect(await listConflicted(repo)).not.toContain('delete-modify.txt');
  }, 30_000);

  test('during a rebase, accept yours takes YOUR commit despite git swapping stages', async () => {
    const repo = fixture('--rebase');
    // Presentation swap: mid-rebase git's --ours is upstream, so "yours" = --theirs.
    await acceptSide(repo, ['modify-modify.txt'], 'yours', true);
    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nOURS two\nthree\n');
  }, 30_000);
});

describe('abortOperation', () => {
  test('aborting a merge clears every conflict and restores the working tree', async () => {
    const repo = fixture();
    expect((await listConflicted(repo)).length).toBeGreaterThan(0);
    await abortOperation(repo, 'merge');
    expect(await listConflicted(repo)).toEqual([]);
    // MERGE_HEAD is gone, so the operation no longer reads as in progress.
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nOURS two\nthree\n');
  }, 30_000);

  test('aborting a rebase returns to the original branch', async () => {
    const repo = fixture('--rebase');
    await abortOperation(repo, 'rebase');
    expect(await listConflicted(repo)).toEqual([]);
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo })
      .toString()
      .trim();
    expect(branch).toBe('main');
  }, 30_000);
});
