import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { applyResolved } from '../src/git/applyResult';
import { listConflicted } from '../src/git/conflicts';
import { loadMergeInputs } from '../src/git/loadMerge';
import { applyEol } from '../src/merge/lineEndings';
import { autoMerge, computeChunks, reassemble } from '../src/merge/engine';

/**
 * Walks a real conflicted repository through the whole pipeline — read stages, chunk,
 * resolve, write back, stage — and checks git agrees the conflict is gone. This is the
 * path a user actually takes; the unit tests each cover one link of it.
 */

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

/** git's own view of whether the merge still has unmerged paths. */
function stillConflicted(repo: string, path: string): boolean {
  return execFileSync('git', ['ls-files', '-u', '--', path], { cwd: repo }).toString() !== '';
}

describe('resolving a conflict end to end', () => {
  test('taking your side writes your version and clears the conflict', async () => {
    const repo = fixture();
    const { payload, hadBom } = await loadMergeInputs(repo, 'modify-modify.txt', 'auto');
    const chunks = computeChunks(payload.base, payload.left, payload.right);
    const result = reassemble(payload.base, payload.left, payload.right, chunks, 'left');

    await applyResolved(repo, 'modify-modify.txt', result, payload.eol.suggested, hadBom);

    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nOURS two\nthree\n');
    expect(stillConflicted(repo, 'modify-modify.txt')).toBe(false);
  }, 30_000);

  test('taking their side writes their version', async () => {
    const repo = fixture();
    const { payload, hadBom } = await loadMergeInputs(repo, 'modify-modify.txt', 'auto');
    const chunks = computeChunks(payload.base, payload.left, payload.right);
    const result = reassemble(payload.base, payload.left, payload.right, chunks, 'right');

    await applyResolved(repo, 'modify-modify.txt', result, payload.eol.suggested, hadBom);
    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nTHEIRS two\nthree\n');
  }, 30_000);

  test('a file without a trailing newline keeps not having one', async () => {
    const repo = fixture();
    const path = 'no-trailing-newline.txt';
    const { payload, hadBom } = await loadMergeInputs(repo, path, 'auto');
    const chunks = computeChunks(payload.base, payload.left, payload.right);
    const result = reassemble(payload.base, payload.left, payload.right, chunks, 'left');

    await applyResolved(repo, path, result, payload.eol.suggested, hadBom);
    const written = readFileSync(join(repo, path), 'utf8');
    expect(written).toBe('ours changed the last line');
    expect(written.endsWith('\n')).toBe(false);
  }, 30_000);

  test('a CRLF file is written back with CRLF, not silently normalized', async () => {
    const repo = fixture();
    const { payload, hadBom } = await loadMergeInputs(repo, 'crlf.txt', 'auto');
    // 'auto' follows your side, which is CRLF here.
    expect(payload.eol.suggested).toBe('crlf');
    const chunks = computeChunks(payload.base, payload.left, payload.right);
    const result = reassemble(payload.base, payload.left, payload.right, chunks, 'left');

    await applyResolved(repo, 'crlf.txt', result, payload.eol.suggested, hadBom);
    const written = readFileSync(join(repo, 'crlf.txt'), 'utf8');
    expect(written).toBe('first\r\nOURS second\r\nthird\r\n');
  }, 30_000);

  test('a both-added file merges from an empty base and keeps both additions', async () => {
    const repo = fixture();
    const { payload, hadBom } = await loadMergeInputs(repo, 'both-added.txt', 'auto');
    expect(payload.base).toBe('');

    const chunks = computeChunks(payload.base, payload.left, payload.right);
    // Take both sides everywhere, which is what Magic Resolve does for pure insertions.
    const result = payload.left + payload.right;
    await applyResolved(repo, 'both-added.txt', result, payload.eol.suggested, hadBom);

    const written = readFileSync(join(repo, 'both-added.txt'), 'utf8');
    expect(written).toContain('ours line 1');
    expect(written).toContain('theirs line 1');
    expect(stillConflicted(repo, 'both-added.txt')).toBe(false);
    expect(chunks.length).toBeGreaterThan(0);
  }, 30_000);

  test('resolving every conflicted file lets the merge commit', async () => {
    const repo = fixture();
    for (const path of await listConflicted(repo)) {
      if (path === 'delete-modify.txt') {
        // No three-pane result exists for a delete/modify; git resolves it by choosing.
        execFileSync('git', ['rm', '-q', '--', path], { cwd: repo });
        continue;
      }
      const { payload, hadBom } = await loadMergeInputs(repo, path, 'auto');
      const chunks = computeChunks(payload.base, payload.left, payload.right);
      const merged = autoMerge(payload.base, payload.left, payload.right, chunks);
      await applyResolved(repo, path, merged, payload.eol.suggested, hadBom);
    }

    expect(await listConflicted(repo)).toEqual([]);
    execFileSync('git', ['commit', '-m', 'resolved via merge-forge'], { cwd: repo });
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: repo }).toString();
    expect(log).toContain('resolved via merge-forge');
  }, 30_000);

  test('the applied bytes are exactly what the result pane held', async () => {
    const repo = fixture();
    const { payload, hadBom } = await loadMergeInputs(repo, 'modify-modify.txt', 'auto');
    // Stand in for a hand-edited result: neither side, written by the user.
    const handWritten = 'one\nhand written\nthree\n';

    await applyResolved(repo, 'modify-modify.txt', handWritten, payload.eol.suggested, hadBom);
    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe(
      applyEol(handWritten, payload.eol.suggested),
    );
  }, 30_000);
});
