import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  blameRanges,
  decorateAuthor,
  dominantAuthor,
  fileHistory,
  githubRemote,
  interleaveLanes,
  loginFromEmail,
  parseBlamePorcelain,
  remoteInfo,
  type RawCommit,
} from '../src/git/authorship';

// Two commits, second sha repeated without metadata — the porcelain dedupe format.
const PORCELAIN = [
  'aaaa111122223333444455556666777788889999 1 1 2',
  'author Jana Doe',
  'author-mail <12345+janadoe@users.noreply.github.com>',
  'author-time 1784196444',
  'author-tz +0200',
  'committer Jana Doe',
  'committer-mail <12345+janadoe@users.noreply.github.com>',
  'committer-time 1784196444',
  'committer-tz +0200',
  'summary fix: metric rounding',
  'filename f.ts',
  '\tline one',
  'aaaa111122223333444455556666777788889999 2 2',
  '\tline two',
  'bbbb111122223333444455556666777788889999 3 3 1',
  'author Alex Behm',
  'author-mail <alex@corp.example>',
  'author-time 1784290851',
  'author-tz +0200',
  'committer Alex Behm',
  'committer-mail <alex@corp.example>',
  'committer-time 1784290851',
  'committer-tz +0200',
  'summary refactor: rename props',
  'filename f.ts',
  '\tline three',
].join('\n');

describe('parseBlamePorcelain', () => {
  test('parses commits with the metadata-once repeat format', () => {
    const records = parseBlamePorcelain(PORCELAIN);
    expect(records).toHaveLength(2);
    const [jana, alex] = records;
    expect(jana?.name).toBe('Jana Doe');
    expect(jana?.email).toBe('12345+janadoe@users.noreply.github.com');
    expect(jana?.timestamp).toBe(1784196444);
    expect(jana?.subject).toBe('fix: metric rounding');
    expect(jana?.sha).toBe('aaaa111122223333444455556666777788889999');
    expect(alex?.name).toBe('Alex Behm');
  });

  test('empty output parses to no records', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });
});

describe('dominantAuthor', () => {
  test('picks the most recent commit touching the range', () => {
    const records = parseBlamePorcelain(PORCELAIN);
    expect(dominantAuthor(records)?.name).toBe('Alex Behm');
  });

  test('empty records → undefined', () => {
    expect(dominantAuthor([])).toBeUndefined();
  });
});

describe('githubRemote', () => {
  test('parses https, ssh, and .git-suffixed forms', () => {
    expect(githubRemote('https://github.com/acme/widgets.git')).toEqual({
      org: 'acme',
      repo: 'widgets',
    });
    expect(githubRemote('https://github.com/acme/widgets')).toEqual({
      org: 'acme',
      repo: 'widgets',
    });
    expect(githubRemote('git@github.com:acme/widgets.git')).toEqual({
      org: 'acme',
      repo: 'widgets',
    });
    expect(githubRemote('ssh://git@github.com/acme/widgets.git')).toEqual({
      org: 'acme',
      repo: 'widgets',
    });
  });

  test('non-GitHub hosts → undefined', () => {
    expect(githubRemote('https://gitlab.com/acme/widgets.git')).toBeUndefined();
    expect(githubRemote('')).toBeUndefined();
  });
});

describe('loginFromEmail', () => {
  test('extracts the login from noreply forms', () => {
    expect(loginFromEmail('12345+janadoe@users.noreply.github.com')).toBe('janadoe');
    expect(loginFromEmail('janadoe@users.noreply.github.com')).toBe('janadoe');
  });

  test('ordinary emails → undefined', () => {
    expect(loginFromEmail('alex@corp.example')).toBeUndefined();
  });
});

describe('decorateAuthor', () => {
  const raw: RawCommit = {
    sha: 'aaaa111122223333444455556666777788889999',
    name: 'Jana Doe',
    email: '12345+janadoe@users.noreply.github.com',
    timestamp: 1784196444,
    subject: 'fix: metric rounding',
  };
  const remote = { org: 'acme', repo: 'widgets' };

  test('github noreply + github remote → avatar, commit, and profile links', () => {
    const author = decorateAuthor(raw, remote);
    expect(author.initials).toBe('JD');
    expect(author.shortSha).toBe('aaaa1111');
    expect(author.avatarUrl).toBe('https://github.com/janadoe.png?size=48');
    expect(author.commitUrl).toBe(
      'https://github.com/acme/widgets/commit/aaaa111122223333444455556666777788889999',
    );
    expect(author.profileUrl).toBe('https://github.com/janadoe');
  });

  test('plain email + github remote → commit link only, no avatar/profile', () => {
    const author = decorateAuthor({ ...raw, email: 'alex@corp.example' }, remote);
    expect(author.avatarUrl).toBeUndefined();
    expect(author.profileUrl).toBeUndefined();
    expect(author.commitUrl).toContain('/commit/');
  });

  test('no remote → no links at all, initials still present', () => {
    const author = decorateAuthor(raw, undefined);
    expect(author.avatarUrl).toBeUndefined();
    expect(author.commitUrl).toBeUndefined();
    expect(author.profileUrl).toBeUndefined();
    expect(author.initials).toBe('JD');
    expect(author.color).toMatch(/^#/);
  });

  test('color is deterministic per email and drawn from a fixed palette', () => {
    // Same email always maps to the same color; different emails may collide
    // (7-color palette) — determinism is the contract, not uniqueness.
    expect(decorateAuthor(raw, undefined).color).toBe(decorateAuthor(raw, undefined).color);
    expect(decorateAuthor(raw, undefined).color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('single-word names get a one-letter initial', () => {
    expect(decorateAuthor({ ...raw, name: 'renovate' }, undefined).initials).toBe('R');
  });
});

describe('interleaveLanes', () => {
  test('merges both sides newest-first with lane tags', () => {
    const mk = (subject: string, timestamp: number): RawCommit => ({
      sha: subject.repeat(8).slice(0, 40),
      name: 'X',
      email: 'x@y.z',
      timestamp,
      subject,
    });
    const entries = interleaveLanes(
      [mk('yours-new', 300), mk('yours-old', 100)].map((c) => decorateAuthor(c, undefined)),
      [mk('theirs-mid', 200)].map((c) => decorateAuthor(c, undefined)),
    );
    expect(entries.map((e) => e.subject)).toEqual(['yours-new', 'theirs-mid', 'yours-old']);
    expect(entries.map((e) => e.lane)).toEqual(['yours', 'theirs', 'yours']);
  });
});

// --- Integration against the fixture repo (mid-merge, like the extension sees) -----

const scriptPath = fileURLToPath(new URL('../scripts/make-conflict-repo.mjs', import.meta.url));

function makeFixture(): string {
  const output = execFileSync('node', [scriptPath], { encoding: 'utf8' });
  const match = /^repo:\s+(.+)$/m.exec(output);
  if (!match?.[1]) {
    throw new Error(`could not parse repo path:\n${output}`);
  }
  return match[1].trim();
}

let repo: string;

beforeAll(() => {
  repo = makeFixture();
}, 60_000);

afterAll(() => {
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('blameRanges (fixture repo)', () => {
  test('returns the fixture author for a conflicted line on both sides', async () => {
    // modify-modify.txt line 2 differs on each side; both revs blame cleanly.
    const yours = await blameRanges(repo, 'HEAD', 'modify-modify.txt', [{ start: 1, end: 2 }]);
    const theirs = await blameRanges(repo, 'MERGE_HEAD', 'modify-modify.txt', [
      { start: 1, end: 2 },
    ]);
    expect(yours.get(0)?.name).toBeTruthy();
    expect(theirs.get(0)?.name).toBeTruthy();
    expect(yours.get(0)?.sha).not.toBe(theirs.get(0)?.sha);
  });

  test('a file absent at the rev yields undefined, not a throw', async () => {
    const result = await blameRanges(repo, 'HEAD', 'no-such-file.txt', [{ start: 0, end: 1 }]);
    expect(result.get(0)).toBeUndefined();
  });

  test('an empty range yields undefined', async () => {
    const result = await blameRanges(repo, 'HEAD', 'modify-modify.txt', [{ start: 1, end: 1 }]);
    expect(result.get(0)).toBeUndefined();
  });
});

describe('fileHistory (fixture repo)', () => {
  test('mid-merge, both lanes and the merge base are found', async () => {
    const history = await fileHistory(repo, 'modify-modify.txt');
    expect(history.yours.length + history.theirs.length).toBeGreaterThan(0);
    expect(history.mergeBase?.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('remoteInfo (fixture repo)', () => {
  test('fixture repo has no origin → undefined, no throw', async () => {
    expect(await remoteInfo(repo)).toBeUndefined();
  });
});
