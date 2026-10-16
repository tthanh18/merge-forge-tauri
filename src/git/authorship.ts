/**
 * Who is behind each side of a conflict, and the commit history that produced the
 * merge. The pure half (parsing, identity derivation, lane interleaving) is
 * unit-tested; the async half shells out to git and never throws — a missing
 * file, empty range, or absent remote degrades to `undefined`.
 *
 * Identity policy (user-confirmed): initials avatars always work; a real GitHub
 * avatar/profile only when the login is derivable from a noreply email; the
 * reliable click target is the commit page, which needs only the remote.
 */

import { git, gitText } from './gitCli';
import { detectOperation, type OperationKind } from './repoContext';

/** A commit as parsed from git, before display decoration. */
export interface RawCommit {
  sha: string;
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  subject: string;
}

/** A display-ready author: identity plus whatever links are safely derivable. */
export interface Author extends RawCommit {
  shortSha: string;
  /** Up to two uppercase letters for the initials avatar. */
  initials: string;
  /** Deterministic per-email color for the initials circle. */
  color: string;
  avatarUrl?: string;
  commitUrl?: string;
  profileUrl?: string;
}

export interface GithubRemote {
  org: string;
  repo: string;
}

/** A timeline row: an author-decorated commit assigned to its branch lane. */
export interface TimelineEntry extends Author {
  lane: 'yours' | 'theirs';
}

// --- pure half --------------------------------------------------------------------

/**
 * Parses `git blame --porcelain` output. Metadata (author, summary, …) appears only
 * the first time a commit is seen; later lines from the same commit carry just the
 * header. Returns one record per distinct commit, in first-seen order.
 */
export function parseBlamePorcelain(output: string): RawCommit[] {
  const bySha = new Map<string, Partial<RawCommit> & { sha: string }>();
  let current: (Partial<RawCommit> & { sha: string }) | undefined;
  for (const line of output.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header?.[1]) {
      const sha = header[1];
      current = bySha.get(sha) ?? { sha };
      bySha.set(sha, current);
      continue;
    }
    if (!current || line.startsWith('\t')) {
      continue;
    }
    if (line.startsWith('author ')) {
      current.name = line.slice('author '.length);
    } else if (line.startsWith('author-mail ')) {
      current.email = line.slice('author-mail '.length).replace(/^<|>$/g, '');
    } else if (line.startsWith('author-time ')) {
      current.timestamp = Number(line.slice('author-time '.length));
    } else if (line.startsWith('summary ')) {
      current.subject = line.slice('summary '.length);
    }
  }
  return [...bySha.values()].filter(
    (r): r is RawCommit => typeof r.name === 'string' && typeof r.timestamp === 'number',
  );
}

/** The commit that last shaped the range — most recent wins. */
export function dominantAuthor(records: readonly RawCommit[]): RawCommit | undefined {
  return records.length === 0
    ? undefined
    : records.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
}

/** Parses an origin URL into org/repo when — and only when — the host is github.com. */
export function githubRemote(url: string): GithubRemote | undefined {
  const match =
    /^(?:https:\/\/|git@|ssh:\/\/git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match?.[1] && match[2] ? { org: match[1], repo: match[2] } : undefined;
}

/** The GitHub login, derivable only from the noreply email forms. */
export function loginFromEmail(email: string): string | undefined {
  const match = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/.exec(email);
  return match?.[1];
}

/** Fixed palette for initials avatars: readable on dark and light themes. */
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948'];

function colorFor(email: string): string {
  let hash = 0;
  for (const ch of email) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0]?.[0] ?? '?');
  return letters.toUpperCase();
}

/** Fills display fields and only the links that are safely derivable. */
export function decorateAuthor(raw: RawCommit, remote: GithubRemote | undefined): Author {
  const login = loginFromEmail(raw.email);
  return {
    ...raw,
    shortSha: raw.sha.slice(0, 8),
    initials: initialsFor(raw.name),
    color: colorFor(raw.email),
    ...(remote && login ? { avatarUrl: `https://github.com/${login}.png?size=48` } : {}),
    ...(remote
      ? { commitUrl: `https://github.com/${remote.org}/${remote.repo}/commit/${raw.sha}` }
      : {}),
    ...(remote && login ? { profileUrl: `https://github.com/${login}` } : {}),
  };
}

/** One chronological list (newest first) with each commit tagged by its branch lane. */
export function interleaveLanes(
  yours: readonly Author[],
  theirs: readonly Author[],
): TimelineEntry[] {
  return [
    ...yours.map((c) => ({ ...c, lane: 'yours' as const })),
    ...theirs.map((c) => ({ ...c, lane: 'theirs' as const })),
  ].sort((a, b) => b.timestamp - a.timestamp);
}

// --- git-backed half --------------------------------------------------------------

/** 0-based half-open line range, matching the merge engine's LineRange. */
export interface BlameRange {
  start: number;
  end: number;
}

/** The parsed origin remote, or undefined when there is none / it is not GitHub. */
export async function remoteInfo(repoRoot: string): Promise<GithubRemote | undefined> {
  try {
    return githubRemote(await gitText(repoRoot, ['remote', 'get-url', 'origin']));
  } catch {
    return undefined;
  }
}

/**
 * The dominant author of each range in `rev`'s version of the file. Ranges are
 * 0-based half-open (engine convention); git blame wants 1-based inclusive.
 * Indexed by position in `ranges`; failures yield undefined entries.
 */
export async function blameRanges(
  repoRoot: string,
  rev: string,
  path: string,
  ranges: readonly BlameRange[],
): Promise<Map<number, Author | undefined>> {
  const remote = await remoteInfo(repoRoot);
  const result = new Map<number, Author | undefined>();
  for (const [index, range] of ranges.entries()) {
    if (range.end <= range.start) {
      result.set(index, undefined);
      continue;
    }
    try {
      const output = await gitText(repoRoot, [
        'blame',
        '--porcelain',
        rev,
        '-L',
        `${range.start + 1},${range.end}`,
        '--',
        path,
      ]);
      const dominant = dominantAuthor(parseBlamePorcelain(output));
      result.set(index, dominant ? decorateAuthor(dominant, remote) : undefined);
    } catch {
      result.set(index, undefined);
    }
  }
  return result;
}

const LOG_CAP = 50;

/** The ref whose commits are "incoming" for each operation kind (see toolHostNode). */
const INCOMING_REF: Record<OperationKind, string> = {
  merge: 'MERGE_HEAD',
  'cherry-pick': 'CHERRY_PICK_HEAD',
  rebase: 'REBASE_HEAD',
  unknown: 'MERGE_HEAD',
};

async function logRange(
  repoRoot: string,
  range: string,
  path: string,
  remote: GithubRemote | undefined,
): Promise<Author[]> {
  try {
    const output = await gitText(repoRoot, [
      'log',
      `--format=%H%x00%an%x00%ae%x00%at%x00%s`,
      '-n',
      String(LOG_CAP),
      range,
      '--',
      path,
    ]);
    if (output === '') {
      return [];
    }
    return output.split('\n').flatMap((line) => {
      const [sha, name, email, time, subject] = line.split('\0');
      if (!sha || !name || !email || !time) {
        return [];
      }
      return [
        decorateAuthor(
          { sha, name, email, timestamp: Number(time), subject: subject ?? '' },
          remote,
        ),
      ];
    });
  } catch {
    return [];
  }
}

export interface FileHistory {
  yours: Author[];
  theirs: Author[];
  mergeBase?: { sha: string; timestamp: number };
}

/**
 * The commits unique to each side that touched this file, plus the merge base.
 * During a rebase the incoming ref carries *your* commits (same swap as elsewhere).
 */
export async function fileHistory(repoRoot: string, path: string): Promise<FileHistory> {
  const [operation, remote] = await Promise.all([detectOperation(repoRoot), remoteInfo(repoRoot)]);
  const ref = INCOMING_REF[operation.kind];
  const [incoming, current] = await Promise.all([
    logRange(repoRoot, `HEAD..${ref}`, path, remote),
    logRange(repoRoot, `${ref}..HEAD`, path, remote),
  ]);
  const [yours, theirs] = operation.kind === 'rebase' ? [incoming, current] : [current, incoming];
  let mergeBase: FileHistory['mergeBase'];
  try {
    const sha = await gitText(repoRoot, ['merge-base', 'HEAD', ref]);
    const time = Number(
      (await git(repoRoot, ['show', '-s', '--format=%at', sha])).toString('utf8').trim(),
    );
    mergeBase = { sha, timestamp: time };
  } catch {
    mergeBase = undefined;
  }
  return { yours, theirs, ...(mergeBase ? { mergeBase } : {}) };
}
