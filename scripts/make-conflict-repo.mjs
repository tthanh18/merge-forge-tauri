#!/usr/bin/env node
/**
 * Builds a throwaway git repository left mid-merge, with one file per conflict shape
 * MergeForge has to handle. Prints the repo path; open it to exercise the UI by hand.
 *
 *   node scripts/make-conflict-repo.mjs            # merge conflict (default)
 *   node scripts/make-conflict-repo.mjs --rebase   # stop mid-rebase instead
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rebase = process.argv.includes('--rebase');
const repo = mkdtempSync(join(tmpdir(), 'merge-forge-fixture-'));

const git = (...args) =>
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

const write = (name, content) => writeFileSync(join(repo, name), content);

/** Files as they exist on the common ancestor. */
const BASE = {
  'modify-modify.txt': 'one\ntwo\nthree\n',
  'one-sided.txt': 'alpha\nbeta\ngamma\ndelta\n',
  'delete-modify.txt': 'to be deleted\n',
  'crlf.txt': 'first\r\nsecond\r\nthird\r\n',
  'no-trailing-newline.txt': 'last line has no newline',
  'identical-change.txt': 'shared\nvalue\n',
};

/** Edits made on the branch you are on (stage 2 / "yours"). */
const OURS = {
  'modify-modify.txt': 'one\nOURS two\nthree\n',
  'one-sided.txt': 'alpha\nBETA (ours only)\ngamma\ndelta\n',
  'delete-modify.txt': 'modified instead of deleted\n',
  'crlf.txt': 'first\r\nOURS second\r\nthird\r\n',
  'no-trailing-newline.txt': 'ours changed the last line',
  'identical-change.txt': 'shared\nIDENTICAL\n',
  'both-added.txt': 'ours line 1\nshared middle\nours line 3\n',
};

/** Edits made on the branch being merged in (stage 3 / "theirs"). */
const THEIRS = {
  'modify-modify.txt': 'one\nTHEIRS two\nthree\n',
  'one-sided.txt': 'alpha\nbeta\ngamma\nDELTA (theirs only)\n',
  'crlf.txt': 'first\nsecond\nTHEIRS third\n',
  'no-trailing-newline.txt': 'theirs changed the last line',
  'identical-change.txt': 'shared\nIDENTICAL\n',
  'both-added.txt': 'theirs line 1\nshared middle\ntheirs line 3\n',
};

git('init', '-b', 'main');
git('config', 'user.email', 'fixture@merge-forge.test');
git('config', 'user.name', 'MergeForge Fixture');
git('config', 'core.autocrlf', 'false');

for (const [name, content] of Object.entries(BASE)) {
  write(name, content);
}
git('add', '-A');
git('commit', '-m', 'base revision');

// The incoming branch, forked from the base commit.
git('checkout', '-b', 'feature');
for (const [name, content] of Object.entries(THEIRS)) {
  write(name, content);
}
git('add', '-A');
git('commit', '-m', 'feature: incoming changes');

// The local branch, also forked from the base commit.
git('checkout', 'main');
for (const [name, content] of Object.entries(OURS)) {
  write(name, content);
}
// delete-modify: main deletes what feature modified.
git('rm', '-q', '--cached', 'delete-modify.txt');
write('delete-modify.txt', OURS['delete-modify.txt']);
git('add', '-A');
git('commit', '-m', 'main: local changes');
git('checkout', 'feature');
git('rm', '-q', 'delete-modify.txt');
git('commit', '-m', 'feature: delete the file main modified');
git('checkout', 'main');

// Leave the repo stopped mid-operation, exactly as a user would find it.
let conflicted = '';
try {
  if (rebase) {
    git('rebase', 'feature');
  } else {
    git('merge', 'feature');
  }
  console.error('warning: expected a conflict but the operation succeeded');
} catch {
  conflicted = git('diff', '--name-only', '--diff-filter=U');
}

const operation = rebase ? 'rebase' : 'merge';
console.log(`repo:        ${repo}`);
console.log(`operation:   ${operation} (stopped on conflict)`);
console.log(`conflicted:\n${conflicted.replace(/^/gm, '  ')}`);
console.log(`\nopen it with:\n  code ${repo}`);
