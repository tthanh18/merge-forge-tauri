import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { applyResolved, encodeResult } from '../src/git/applyResult';
import { listConflicted } from '../src/git/conflicts';

const scriptPath = fileURLToPath(new URL('../scripts/make-conflict-repo.mjs', import.meta.url));

function makeFixture(): string {
  const output = execFileSync('node', [scriptPath], { encoding: 'utf8' });
  const path = /^repo:\s+(.+)$/m.exec(output)?.[1];
  if (!path) {
    throw new Error(`could not parse repo path:\n${output}`);
  }
  return path.trim();
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): string {
  const repo = makeFixture();
  created.push(repo);
  return repo;
}

describe('encodeResult', () => {
  test('writes LF as-is', () => {
    expect(encodeResult('a\nb\n', 'lf', false).toString()).toBe('a\nb\n');
  });

  test('restores CRLF line endings', () => {
    expect(encodeResult('a\nb\n', 'crlf', false).toString()).toBe('a\r\nb\r\n');
  });

  test('re-attaches a BOM the file originally had', () => {
    const encoded = encodeResult('a\n', 'lf', true);
    expect(encoded[0]).toBe(0xef);
    expect(encoded[1]).toBe(0xbb);
    expect(encoded[2]).toBe(0xbf);
    expect(encoded.toString('utf8').slice(1)).toBe('a\n');
  });

  test('does not double a BOM already present in the content', () => {
    expect(encodeResult('﻿a\n', 'lf', true).toString('utf8')).toBe('﻿a\n');
  });

  test('drops a BOM when the file never had one', () => {
    expect(encodeResult('﻿a\n', 'lf', false).toString('utf8')).toBe('a\n');
  });

  test('preserves a missing trailing newline', () => {
    expect(encodeResult('a\nb', 'lf', false).toString()).toBe('a\nb');
  });
});

describe('applyResolved', () => {
  test('writes the result and stages it so git stops reporting a conflict', async () => {
    const repo = fixture();
    expect(await listConflicted(repo)).toContain('modify-modify.txt');

    await applyResolved(repo, 'modify-modify.txt', 'one\nRESOLVED\nthree\n', 'lf', false);

    expect(readFileSync(join(repo, 'modify-modify.txt'), 'utf8')).toBe('one\nRESOLVED\nthree\n');
    expect(await listConflicted(repo)).not.toContain('modify-modify.txt');
  }, 30_000);

  test('the staged blob matches what was written, not the conflicted version', async () => {
    const repo = fixture();
    await applyResolved(repo, 'modify-modify.txt', 'one\nRESOLVED\nthree\n', 'lf', false);
    const staged = execFileSync('git', ['show', ':modify-modify.txt'], { cwd: repo }).toString();
    expect(staged).toBe('one\nRESOLVED\nthree\n');
  }, 30_000);

  test('writes CRLF back to disk when that is the chosen ending', async () => {
    const repo = fixture();
    await applyResolved(repo, 'crlf.txt', 'first\nsecond\nthird\n', 'crlf', false);
    expect(readFileSync(join(repo, 'crlf.txt'), 'utf8')).toBe('first\r\nsecond\r\nthird\r\n');
  }, 30_000);

  test('resolving every file leaves the merge ready to commit', async () => {
    const repo = fixture();
    for (const path of await listConflicted(repo)) {
      // delete/modify has no three-pane result; the panel refuses it, so skip it here too.
      if (path === 'delete-modify.txt') {
        continue;
      }
      await applyResolved(repo, path, 'resolved\n', 'lf', false);
    }
    expect(await listConflicted(repo)).toEqual(['delete-modify.txt']);
  }, 30_000);
});
