/**
 * Message protocol between the extension host and the webview.
 * This module must stay free of `vscode` and DOM imports — it is bundled into both sides.
 */

export type Eol = 'lf' | 'crlf';

export interface EolInfo {
  left: Eol;
  base: Eol;
  right: Eol;
  /** True when the three versions disagree on line endings. */
  conflict: boolean;
  /** The EOL the result should default to. */
  suggested: Eol;
}

export interface InitPayload {
  /** Workspace-relative path, for display. */
  filePath: string;
  /** Monaco language id derived from the file name. */
  languageId: string;
  /** Contents are always \n-normalized; EOL is restored on apply. */
  left: string;
  base: string;
  right: string;
  labels: { left: string; right: string };
  eol: EolInfo;
  settings: {
    autoApplyNonConflicting: boolean;
    /** The user's editor font, so the panes match their code everywhere else. */
    font?: { size: number; family: string; ligatures: boolean };
  };
}

export type MergeAction = 'nextChange' | 'prevChange' | 'applyAllNonConflicting' | 'requestApply';

// --- Crash-safety work snapshots ---------------------------------------------------

/** A resumable picture of in-progress work: the result text plus every chunk's state. */
export interface WorkSnapshot {
  content: string;
  /** The whitespace mode the chunks were computed under; restoring re-applies it. */
  whitespace: string;
  chunks: Array<{
    id: number;
    state: string;
    dismissedLeft: boolean;
    dismissedRight: boolean;
    /** The chunk's center range at snapshot time (0-based half-open lines). */
    start: number;
    end: number;
  }>;
}

// --- Conflict authorship + history -------------------------------------------------

/**
 * A display-ready commit author. `src/git/authorship.ts`'s `Author` satisfies this
 * shape structurally; it is restated here so the protocol stays import-free.
 */
export interface AuthorInfo {
  sha: string;
  shortSha: string;
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  subject: string;
  initials: string;
  color: string;
  avatarUrl?: string;
  commitUrl?: string;
  profileUrl?: string;
}

export interface TimelineEntryInfo extends AuthorInfo {
  lane: 'yours' | 'theirs';
}

/** Per-conflict blame request: each side's line range in its own document. */
export interface BlameRangeRequest {
  chunkId: number;
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}

export interface HistoryPayload {
  /** Pre-interleaved newest-first; each entry carries its lane. */
  entries: TimelineEntryInfo[];
  mergeBase?: { sha: string; timestamp: number };
  branches: { yours: string; theirs: string };
}

// --- AI explain -------------------------------------------------------------------

export interface ExplainConflict {
  /** 1-based position among the file's conflicts, for "Conflict N" headings. */
  index: number;
  /** The webview's chunk id, echoed back so resolutions land on the right chunk. */
  chunkId: number;
  baseText: string;
  leftText: string;
  rightText: string;
  /** The conflict's location in `resultText` (0-based half-open lines), for context windows. */
  resultStart: number;
  resultEnd: number;
}

export interface ExplainRequest {
  filePath: string;
  languageId: string;
  labels: { left: string; right: string };
  /** The current result document — the rich baseline the model reads around the conflicts. */
  resultText: string;
  conflicts: ExplainConflict[];
}

export type HostToWebviewMessage =
  | { type: 'init'; payload: InitPayload }
  | { type: 'runAction'; action: MergeAction }
  | { type: 'applyResult'; ok: boolean; error?: string }
  | { type: 'offerRestore'; payload: WorkSnapshot }
  | { type: 'explainDelta'; text: string }
  /** A live progress line while the model works its tools: "⚙ Read src/x.ts". */
  | { type: 'explainActivity'; text: string }
  | { type: 'explainDone'; truncated?: boolean }
  | { type: 'explainError'; message: string; unconfigured?: boolean }
  | {
      type: 'aiResolutions';
      resolutions: Array<{ chunkId: number; text: string }>;
      /** Conflicts the model skipped or answered unparseably — they stay open. */
      missing: number;
    }
  | {
      type: 'blameResult';
      payload: Array<{ chunkId: number; left?: AuthorInfo; right?: AuthorInfo }>;
    }
  | { type: 'historyData'; payload: HistoryPayload };

export interface StatePayload {
  totalChunks: number;
  unresolvedConflicts: number;
  /** Unresolved chunks of any kind (drives the "N changes remaining" counter). */
  pendingChanges: number;
  /** True once the center document differs from its initial content. */
  dirty: boolean;
}

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'state'; payload: StatePayload }
  | { type: 'apply'; payload: { content: string; eol: Eol } }
  | { type: 'abort' }
  | { type: 'explain'; payload: ExplainRequest }
  | { type: 'aiResolve'; payload: { request: ExplainRequest; explanation?: string } }
  | {
      type: 'aiAsk';
      payload: {
        request: ExplainRequest;
        history: Array<{ question: string; answer: string }>;
        question: string;
      };
    }
  | { type: 'explainCancel' }
  | { type: 'openAiSetup' }
  | { type: 'workSnapshot'; payload: WorkSnapshot }
  | { type: 'discardWork' }
  | { type: 'blame'; payload: { ranges: BlameRangeRequest[] } }
  | { type: 'history' }
  | { type: 'log'; level: 'warn' | 'error'; message: string };

// --- Conflicts dialog (the file-list webview, separate bundle) ---------------------

export interface ConflictFileEntry {
  path: string;
  yours: string;
  theirs: string;
  /** False for delete/modify rows: no three-pane view exists, Accept buttons resolve. */
  mergeable: boolean;
}

export interface ConflictsData {
  files: ConflictFileEntry[];
  branches: { yours: string; theirs: string };
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'unknown';
  /** Most files seen conflicted this operation — the denominator for "2 of 5 resolved". */
  totalAtStart: number;
}

export type HostToConflictsMessage = { type: 'conflicts'; payload: ConflictsData };

export type ConflictsToHostMessage =
  | { type: 'ready' }
  | { type: 'acceptSide'; payload: { paths: string[]; side: 'yours' | 'theirs' } }
  | { type: 'openMerge'; payload: { path: string } }
  | { type: 'resolveDeleteModify'; payload: { path: string } }
  | { type: 'close' };
