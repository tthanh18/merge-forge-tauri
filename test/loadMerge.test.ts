import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { contentGuard, loadMergeInputs, MAX_MERGE_BYTES } from '../src/git/loadMerge';

const scriptPath = fileURLToPath(new URL('../scripts/make-conflict-repo.mjs', import.meta.url));

function makeFixture(...args: string[]): string {
  const output = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  const path = /^repo:\s+(.+)$/m.exec(output)?.[1];
  if (!path) {
    throw new Error(`could not parse repo path:\n${output}`);
  }
  return path.trim();
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

describe('loadMergeInputs', () => {
  test('puts your local content on the left during a merge', async () => {
    const { payload } = await loadMergeInputs(repo, 'modify-modify.txt', 'auto');
    expect(payload.left).toContain('OURS two');
    expect(payload.right).toContain('THEIRS two');
    expect(payload.base).toBe('one\ntwo\nthree\n');
    expect(payload.labels).toEqual({ left: 'main', right: 'feature' });
  });

  test('still puts YOUR commit on the left during a rebase, despite git swapping stages', async () => {
    const { payload } = await loadMergeInputs(rebaseRepo, 'modify-modify.txt', 'auto');
    expect(payload.left).toContain('OURS two');
    expect(payload.right).toContain('THEIRS two');
    // Even mid-rebase (detached HEAD) the left pane must carry YOUR branch's name.
    expect(payload.labels).toEqual({ left: 'main', right: 'feature' });
  });

  test('treats a both-added conflict as having an empty base', async () => {
    const { payload, unsupported } = await loadMergeInputs(repo, 'both-added.txt', 'auto');
    expect(unsupported).toBeUndefined();
    expect(payload.base).toBe('');
    expect(payload.left).toContain('ours line 1');
    expect(payload.right).toContain('theirs line 1');
  });

  test('flags a delete/modify conflict as unsupported rather than showing empty panes', async () => {
    const { unsupported } = await loadMergeInputs(repo, 'delete-modify.txt', 'auto');
    expect(unsupported).toBe('deletedByThem');
  });

  test('normalizes CRLF for diffing but records the disagreement', async () => {
    const { payload } = await loadMergeInputs(repo, 'crlf.txt', 'auto');
    expect(payload.left).not.toContain('\r');
    expect(payload.right).not.toContain('\r');
    expect(payload.eol.conflict).toBe(true);
    expect(payload.eol.left).toBe('crlf');
    expect(payload.eol.right).toBe('lf');
    // 'auto' keeps your side's ending.
    expect(payload.eol.suggested).toBe('crlf');
  });

  test('honors an explicit line-ending setting over the local side', async () => {
    const { payload } = await loadMergeInputs(repo, 'crlf.txt', 'lf');
    expect(payload.eol.suggested).toBe('lf');
  });
});

describe('contentGuard', () => {
  const text = Buffer.from('ordinary text\nwith lines\n', 'utf8');

  test('plain text passes', () => {
    expect(contentGuard({ ours: text, theirs: text, base: text })).toBeUndefined();
  });

  test('a NUL byte on any side reads as binary', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    expect(contentGuard({ ours: binary, theirs: text, base: text })).toBe('binary');
    expect(contentGuard({ ours: text, theirs: binary, base: text })).toBe('binary');
    expect(contentGuard({ ours: text, theirs: text, base: binary })).toBe('binary');
  });

  test('any side over the size cap reads as tooLarge', () => {
    const huge = Buffer.alloc(MAX_MERGE_BYTES + 1, 0x61);
    expect(contentGuard({ ours: huge, theirs: text, base: text })).toBe('tooLarge');
  });

  test('missing sides (delete/modify, both-added) are simply not checked', () => {
    expect(contentGuard({ ours: text })).toBeUndefined();
  });

  test('binary wins over tooLarge so the message names the real problem', () => {
    const hugeBinary = Buffer.alloc(MAX_MERGE_BYTES + 1, 0x00);
    expect(contentGuard({ ours: hugeBinary })).toBe('binary');
  });
});
