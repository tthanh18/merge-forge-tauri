/**
 * Node-only tool executors: filesystem reads, `git grep` search, and branch-intent
 * summaries. No vscode import — the extension host wraps these (adding the
 * language-service `findSymbol`), and the dev eval script reuses them verbatim.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gitText } from '../git/gitCli';
import { detectOperation, type OperationKind } from '../git/repoContext';
import {
  GIT_DIFF_CAP,
  GIT_MAX_SUBJECTS,
  READ_FILE_MAX_LINES,
  SEARCH_CONTEXT_LINES,
  SEARCH_MAX_HITS,
  type GitContextInput,
  type ReadFileInput,
  type SearchCodeInput,
  type ToolExecutors,
} from './tools';

export interface BranchSubjects {
  yours: string[];
  theirs: string[];
}

/** The ref whose commits are "incoming" for each operation kind. */
const INCOMING_REF: Record<OperationKind, string> = {
  merge: 'MERGE_HEAD',
  'cherry-pick': 'CHERRY_PICK_HEAD',
  rebase: 'REBASE_HEAD',
  unknown: 'MERGE_HEAD',
};

async function subjectsFor(repoRoot: string, range: string): Promise<string[]> {
  try {
    const out = await gitText(repoRoot, [
      'log',
      '--format=%h %s',
      '-n',
      String(GIT_MAX_SUBJECTS),
      range,
    ]);
    return out === '' ? [] : out.split('\n');
  } catch {
    return [];
  }
}

/**
 * Commit subjects unique to each side of the in-progress operation. During a
 * rebase the incoming ref (REBASE_HEAD) is *your* commit being replayed, so the
 * sides swap — same reasoning as `Operation.swapPresentation`.
 */
export async function branchSubjects(repoRoot: string): Promise<BranchSubjects> {
  const operation = await detectOperation(repoRoot);
  const ref = INCOMING_REF[operation.kind];
  const incoming = await subjectsFor(repoRoot, `HEAD..${ref}`);
  const current = await subjectsFor(repoRoot, `${ref}..HEAD`);
  return operation.kind === 'rebase'
    ? { yours: incoming, theirs: current }
    : { yours: current, theirs: incoming };
}

function resolveInside(repoRoot: string, relativePath: string): string {
  const abs = resolve(repoRoot, relativePath);
  if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) {
    throw new Error(`path "${relativePath}" is outside the workspace`);
  }
  return abs;
}

async function readFileExecutor(repoRoot: string, input: ReadFileInput): Promise<string> {
  const abs = resolveInside(repoRoot, input.path);
  const text = await fsReadFile(abs, 'utf8');
  const lines = text.split('\n');
  if (typeof input.startLine === 'number' && typeof input.endLine === 'number') {
    const start = Math.max(1, Math.floor(input.startLine));
    const end = Math.min(lines.length, Math.floor(input.endLine));
    const slice = lines.slice(start - 1, end);
    return `${input.path} lines ${start}–${end}:\n${slice.join('\n')}`;
  }
  if (lines.length > READ_FILE_MAX_LINES) {
    return (
      `${input.path} (truncated at ${READ_FILE_MAX_LINES} of ${lines.length} lines — ` +
      `pass startLine/endLine for the rest):\n` +
      lines.slice(0, READ_FILE_MAX_LINES).join('\n')
    );
  }
  return `${input.path}:\n${text}`;
}

async function searchCodeExecutor(repoRoot: string, input: SearchCodeInput): Promise<string> {
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    throw new Error('searchCode needs a non-empty query');
  }
  let out: string;
  try {
    // git grep: tracked text files only, fixed string — the same corpus the
    // merge actually concerns, with .gitignore noise excluded for free.
    out = await gitText(repoRoot, [
      'grep',
      '-n',
      '-F',
      '-I',
      `--context=${SEARCH_CONTEXT_LINES}`,
      '--max-count',
      String(SEARCH_MAX_HITS),
      '--',
      input.query,
    ]);
  } catch {
    // git grep exits 1 on no matches.
    return `No matches for "${input.query}" in tracked files.`;
  }
  // Cap total hits across files: match lines are "path:NN:", context lines "path-NN-".
  const lines = out.split('\n');
  let hits = 0;
  for (const [i, line] of lines.entries()) {
    if (/^[^:\n]+:\d+:/.test(line)) {
      hits += 1;
      if (hits > SEARCH_MAX_HITS) {
        return `${lines.slice(0, i).join('\n')}\n… capped at ${SEARCH_MAX_HITS} hits — refine the query for more.`;
      }
    }
  }
  // The per-file --max-count already trimmed inside a file; say so when it bit.
  if (hits >= SEARCH_MAX_HITS) {
    return `${out}\n… capped at ${SEARCH_MAX_HITS} hits per file — refine the query for more.`;
  }
  return out;
}

async function gitContextExecutor(repoRoot: string, input: GitContextInput): Promise<string> {
  if (typeof input.commit === 'string' && input.commit !== '') {
    if (!/^[0-9a-f]{4,40}$/i.test(input.commit)) {
      throw new Error(`"${input.commit}" is not a commit hash`);
    }
    const diff = await gitText(repoRoot, ['show', '--stat', '--patch', input.commit]);
    return diff.length > GIT_DIFF_CAP ? `${diff.slice(0, GIT_DIFF_CAP)}\n…truncated…` : diff;
  }
  const subjects = await branchSubjects(repoRoot);
  const lines: string[] = [];
  if (input.side !== 'theirs') {
    lines.push(
      'Commits only on YOURS:',
      ...(subjects.yours.length > 0 ? subjects.yours.map((s) => `- ${s}`) : ['- (none found)']),
    );
  }
  if (input.side !== 'yours') {
    lines.push(
      'Commits only on THEIRS:',
      ...(subjects.theirs.length > 0 ? subjects.theirs.map((s) => `- ${s}`) : ['- (none found)']),
    );
  }
  lines.push('', 'Pass a commit hash to see its full diff.');
  return lines.join('\n');
}

/**
 * Executors for everything that needs only node + git. `findSymbol` reports its
 * unavailability here; the extension host overrides it with the language-service
 * implementation.
 */
export function createNodeExecutors(repoRoot: string): ToolExecutors {
  return {
    readFile: (input) => readFileExecutor(repoRoot, input),
    searchCode: (input) => searchCodeExecutor(repoRoot, input),
    gitContext: (input) => gitContextExecutor(repoRoot, input),
    findSymbol: async ({ name }) =>
      `No symbol provider available here — use searchCode with "${name}" instead.`,
  };
}
