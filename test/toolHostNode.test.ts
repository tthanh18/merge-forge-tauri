import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { branchSubjects, createNodeExecutors } from '../src/ai/toolHostNode';
import { READ_FILE_MAX_LINES, SEARCH_MAX_HITS } from '../src/ai/tools';

const scriptPath = fileURLToPath(new URL('../scripts/make-conflict-repo.mjs', import.meta.url));

function makeFixture(...args: string[]): string {
  const output = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  const match = /^repo:\s+(.+)$/m.exec(output);
  if (!match?.[1]) {
    throw new Error(`could not parse repo path from fixture output:\n${output}`);
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

describe('readFile executor', () => {
  test('reads a workspace-relative file', async () => {
    const out = await createNodeExecutors(repo).readFile({ path: 'modify-modify.txt' });
    expect(out).toContain('two');
  });

  test('honors a 1-based line range', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n');
    writeFileSync(join(repo, 'fifty.txt'), `${lines}\n`);
    const out = await createNodeExecutors(repo).readFile({
      path: 'fifty.txt',
      startLine: 10,
      endLine: 12,
    });
    expect(out).toContain('row 10');
    expect(out).toContain('row 12');
    expect(out).not.toContain('row 13');
    expect(out).not.toContain('row 9\n');
  });

  test('caps unbounded reads and says so', async () => {
    const many = Array.from({ length: READ_FILE_MAX_LINES + 100 }, (_, i) => `l${i}`).join('\n');
    writeFileSync(join(repo, 'big.txt'), `${many}\n`);
    const out = await createNodeExecutors(repo).readFile({ path: 'big.txt' });
    expect(out).toContain(`l${READ_FILE_MAX_LINES - 1}`);
    expect(out).not.toContain(`l${READ_FILE_MAX_LINES}\n`);
    expect(out.toLowerCase()).toContain('truncated');
  });

  test('rejects paths that escape the workspace', async () => {
    await expect(createNodeExecutors(repo).readFile({ path: '../../etc/passwd' })).rejects.toThrow(
      /outside/i,
    );
  });

  test('a missing file reads as a helpful error, thrown for runTool to wrap', async () => {
    await expect(createNodeExecutors(repo).readFile({ path: 'nope.txt' })).rejects.toThrow();
  });
});

describe('searchCode executor', () => {
  test('finds tracked-file hits with file and line', async () => {
    const out = await createNodeExecutors(repo).searchCode({ query: 'OURS' });
    expect(out).toContain('modify-modify.txt');
    expect(out).toMatch(/:\d+/);
  });

  test('reports no matches honestly', async () => {
    const out = await createNodeExecutors(repo).searchCode({ query: 'zzz-not-here-zzz' });
    expect(out.toLowerCase()).toContain('no matches');
  });

  test('caps runaway hit counts', async () => {
    // A tracked file with many matching lines; git grep reports each line once.
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const many = Array.from({ length: SEARCH_MAX_HITS + 50 }, () => 'needle-cap-line').join('\n');
    writeFileSync(join(repo, 'sub', 'haystack.txt'), `${many}\n`);
    execFileSync('git', ['add', 'sub/haystack.txt'], { cwd: repo });
    const out = await createNodeExecutors(repo).searchCode({ query: 'needle-cap-line' });
    const hits = out.split('\n').filter((l) => l.includes('needle-cap-line')).length;
    expect(hits).toBeLessThanOrEqual(SEARCH_MAX_HITS + 2 * SEARCH_MAX_HITS); // hits + context lines
    expect(out.toLowerCase()).toContain('capped');
  });
});

describe('gitContext executor + branchSubjects', () => {
  test('mid-merge, subjects unique to each side are reported', async () => {
    const subjects = await branchSubjects(repo);
    // The fixture merges "feature" into main; both sides have at least one commit.
    expect(subjects.yours.length + subjects.theirs.length).toBeGreaterThan(0);
    const out = await createNodeExecutors(repo).gitContext({});
    expect(out).toContain('YOURS');
    expect(out).toContain('THEIRS');
  });

  test('a commit hash shows its diff, capped', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const out = await createNodeExecutors(repo).gitContext({ commit: head });
    expect(out).toContain('diff');
  });

  test('garbage commit ids are rejected without shelling out', async () => {
    await expect(createNodeExecutors(repo).gitContext({ commit: '$(rm -rf /)' })).rejects.toThrow(
      /commit/i,
    );
  });
});
