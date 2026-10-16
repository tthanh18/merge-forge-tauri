import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import {
  buildChatPrompt,
  buildExplainPrompt,
  buildResolvePrompt,
  buildRetryAddendum,
  type PromptContext,
} from '../ai/prompt';
import {
  getExplainProvider,
  STEP_BUDGET_EXPLAIN,
  STEP_BUDGET_RESOLVE,
  type ExplainProvider,
  type PromptPair,
  type StreamToolOptions,
} from '../ai/provider';
import { parseResolutions } from '../ai/resolveParser';
import { createToolExecutors } from '../ai/toolHost';
import { branchSubjects, type BranchSubjects } from '../ai/toolHostNode';
import { applyResolved } from '../git/applyResult';
import { blameRanges, fileHistory, interleaveLanes } from '../git/authorship';
import { listConflicted } from '../git/conflicts';
import { loadMergeInputs, type UnsupportedReason } from '../git/loadMerge';
import { getOutputChannel } from '../log';
import { detectOperation, findRepoRoot } from '../git/repoContext';
import type { EolSetting } from '../merge/lineEndings';
import type {
  BlameRangeRequest,
  Eol,
  ExplainRequest,
  HistoryPayload,
  HostToWebviewMessage,
  InitPayload,
  MergeAction,
  StatePayload,
  WebviewToHostMessage,
  WorkSnapshot,
} from '../protocol';
import { getWebviewHtml } from './html';

/**
 * One merge panel per conflicted file. Owns the webview lifecycle, loads the three
 * versions from git, and bridges messages; the merge UI itself lives in the webview.
 */
export class MergePanel {
  private static readonly panels = new Map<string, MergePanel>();

  private latestState: StatePayload | undefined;
  /** Cancels the in-flight AI explanation; recreated per request. */
  private explainCancellation: vscode.CancellationTokenSource | undefined;
  /** Commit subjects unique to each side; computed once, they don't change mid-merge. */
  private subjects: BranchSubjects | undefined;
  /** File history fetched once per session; the timeline can be toggled repeatedly. */
  private history: HistoryPayload | undefined;

  static async createOrShow(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const existing = MergePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const repoRoot = await findRepoRoot(uri.fsPath);
    if (!repoRoot) {
      void vscode.window.showErrorMessage('Merge Forge: this file is not inside a git repository.');
      return;
    }
    const relativePath = relative(repoRoot, uri.fsPath);

    let inputs: Awaited<ReturnType<typeof loadMergeInputs>>;
    try {
      inputs = await loadMergeInputs(repoRoot, relativePath, readEolSetting());
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Merge Forge: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (inputs.unsupported) {
      await showUnsupported(inputs.unsupported, relativePath);
      return;
    }

    // Tab-title progress: "(2/5)" — position in the conflicted list at open time.
    const conflicted = await listConflicted(repoRoot).catch(() => [] as string[]);
    const position = conflicted.indexOf(relativePath) + 1;
    const progress =
      position > 0 && conflicted.length > 1 ? ` (${position}/${conflicted.length})` : '';
    const panel = vscode.window.createWebviewPanel(
      'mergeForge.mergeEditor',
      `Merge: ${relativePath}${progress}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The center pane holds unsaved work; rebuilding it on every tab switch would lose it.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );

    const payload = {
      ...inputs.payload,
      filePath: relativePath,
      languageId: await detectLanguageId(uri),
      settings: { autoApplyNonConflicting: readAutoApply(), font: readEditorFont() },
    };
    // Fingerprint of the three inputs: stale saved work (index moved on) never matches.
    const inputsHash = createHash('sha1')
      .update(payload.base)
      .update('\0')
      .update(payload.left)
      .update('\0')
      .update(payload.right)
      .digest('hex');
    MergePanel.panels.set(
      key,
      new MergePanel(
        panel,
        context,
        key,
        uri,
        payload,
        repoRoot,
        relativePath,
        inputs.hadBom,
        inputsHash,
      ),
    );
  }

  /** Forwards a command to the focused merge panel, if there is one. */
  static runOnActive(action: MergeAction): void {
    for (const panel of MergePanel.panels.values()) {
      if (panel.panel.active) {
        panel.post({ type: 'runAction', action });
        return;
      }
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly key: string,
    readonly uri: vscode.Uri,
    private readonly payload: InitPayload,
    private readonly repoRoot: string,
    private readonly relativePath: string,
    private readonly hadBom: boolean,
    private readonly inputsHash: string,
  ) {
    this.panel.webview.html = getWebviewHtml(this.panel.webview, context.extensionUri);
    this.panel.onDidDispose(() => {
      MergePanel.panels.delete(this.key);
      this.cancelExplain();
      void vscode.commands.executeCommand('setContext', 'mergeForge.panelFocused', false);
    });
    this.panel.onDidChangeViewState(() => {
      void vscode.commands.executeCommand(
        'setContext',
        'mergeForge.panelFocused',
        this.panel.active,
      );
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
      this.onMessage(message),
    );
  }

  private post(message: HostToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private onMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'ready': {
        this.post({ type: 'init', payload: this.payload });
        // Offer earlier unsaved work back — only when the inputs are byte-identical.
        const saved = this.context.workspaceState.get<StoredWork>(this.workKey());
        if (saved && saved.inputsHash === this.inputsHash) {
          this.post({ type: 'offerRestore', payload: saved.snapshot });
        }
        break;
      }
      case 'workSnapshot':
        void this.context.workspaceState.update(this.workKey(), {
          inputsHash: this.inputsHash,
          snapshot: message.payload,
          savedAt: Date.now(),
        } satisfies StoredWork);
        break;
      case 'discardWork':
        void this.context.workspaceState.update(this.workKey(), undefined);
        break;
      case 'state':
        this.latestState = message.payload;
        break;
      case 'abort':
        void this.abort();
        break;
      case 'log':
        // The output channel is where users can actually see this; console mirrors for dev.
        getOutputChannel().appendLine(
          `[${message.level}] ${this.relativePath}: ${message.message}`,
        );
        console[message.level === 'error' ? 'error' : 'warn'](`[merge-forge] ${message.message}`);
        break;
      case 'apply':
        void this.apply(message.payload.content, message.payload.eol);
        break;
      case 'explain':
        void this.explain(message.payload);
        break;
      case 'aiResolve':
        void this.aiResolve(message.payload.request, message.payload.explanation);
        break;
      case 'aiAsk':
        void this.aiAsk(message.payload.request, message.payload.history, message.payload.question);
        break;
      case 'explainCancel':
        this.cancelExplain();
        break;
      case 'openAiSetup':
        void vscode.commands.executeCommand('mergeForge.setApiKey');
        break;
      case 'blame':
        void this.blame(message.payload.ranges);
        break;
      case 'history':
        void this.sendHistory();
        break;
    }
  }

  /**
   * Blames each conflict's side ranges against the side's committed rev. During a
   * rebase/cherry-pick git's incoming ref is what the left ("yours") pane shows —
   * the same swap `loadMergeInputs` applies to the pane contents.
   */
  private async blame(ranges: BlameRangeRequest[]): Promise<void> {
    try {
      const operation = await detectOperation(this.repoRoot);
      const incoming =
        operation.kind === 'cherry-pick'
          ? 'CHERRY_PICK_HEAD'
          : operation.kind === 'rebase'
            ? 'REBASE_HEAD'
            : 'MERGE_HEAD';
      const [leftRev, rightRev] = operation.swapPresentation
        ? [incoming, 'HEAD']
        : ['HEAD', incoming];
      const [left, right] = await Promise.all([
        blameRanges(
          this.repoRoot,
          leftRev,
          this.relativePath,
          ranges.map((r) => ({ start: r.leftStart, end: r.leftEnd })),
        ),
        blameRanges(
          this.repoRoot,
          rightRev,
          this.relativePath,
          ranges.map((r) => ({ start: r.rightStart, end: r.rightEnd })),
        ),
      ]);
      this.post({
        type: 'blameResult',
        payload: ranges.map((r, i) => ({
          chunkId: r.chunkId,
          ...(left.get(i) ? { left: left.get(i)! } : {}),
          ...(right.get(i) ? { right: right.get(i)! } : {}),
        })),
      });
    } catch {
      // Authorship is an enrichment — a failure just means no chips.
    }
  }

  private async sendHistory(): Promise<void> {
    try {
      if (!this.history) {
        const history = await fileHistory(this.repoRoot, this.relativePath);
        this.history = {
          entries: interleaveLanes(history.yours, history.theirs),
          ...(history.mergeBase ? { mergeBase: history.mergeBase } : {}),
          branches: {
            yours: this.payload.labels.left,
            theirs: this.payload.labels.right,
          },
        };
      }
      this.post({ type: 'historyData', payload: this.history });
    } catch {
      this.post({
        type: 'historyData',
        payload: {
          entries: [],
          branches: { yours: this.payload.labels.left, theirs: this.payload.labels.right },
        },
      });
    }
  }

  /** The streaming callbacks every drawer-bound request shares. */
  private drawerCallbacks(): {
    onDelta(text: string): void;
    onActivity(text: string): void;
    onDone(truncated?: boolean): void;
    onError(message: string): void;
  } {
    return {
      onDelta: (text) => this.post({ type: 'explainDelta', text }),
      onActivity: (text) => this.post({ type: 'explainActivity', text }),
      onDone: (truncated) =>
        this.post({ type: 'explainDone', ...(truncated ? { truncated: true } : {}) }),
      onError: (message) => this.post({ type: 'explainError', message }),
    };
  }

  /** Streams an AI explanation of the file's conflicts back into the webview drawer. */
  private async explain(request: ExplainRequest): Promise<void> {
    const started = await this.startAiRequest(STEP_BUDGET_EXPLAIN);
    if (!started) {
      return;
    }
    await started.provider.stream(
      buildExplainPrompt(request, started.context),
      this.drawerCallbacks(),
      started.token,
      started.tools,
    );
  }

  /**
   * "Resolve with AI": one request returns machine-parsed merged blocks; only what
   * parses is sent back — a skipped or garbled block just leaves that conflict open.
   * One automatic retry covers indexes the first answer missed or garbled.
   */
  private async aiResolve(request: ExplainRequest, explanation?: string): Promise<void> {
    const started = await this.startAiRequest(STEP_BUDGET_RESOLVE);
    if (!started) {
      return;
    }
    const base = buildResolvePrompt(request, explanation, started.context);
    const collected = new Map<number, string>();
    const expected = request.conflicts.map((c) => c.index);

    const postResolutions = (): void => {
      const resolutions = request.conflicts
        .filter((c) => collected.has(c.index))
        .map((c) => ({ chunkId: c.chunkId, text: collected.get(c.index)! }));
      this.post({
        type: 'aiResolutions',
        resolutions,
        missing: request.conflicts.length - resolutions.length,
      });
    };

    const attempt = async (prompt: PromptPair, isRetry: boolean): Promise<void> => {
      let accumulated = '';
      await started.provider.stream(
        prompt,
        {
          ...this.drawerCallbacks(),
          onDelta: (text) => {
            accumulated += text;
          },
          onDone: () => {
            for (const [index, text] of parseResolutions(accumulated, expected)) {
              if (!collected.has(index)) {
                collected.set(index, text);
              }
            }
            const missing = expected.filter((i) => !collected.has(i));
            if (missing.length === 0 || isRetry || started.token.isCancellationRequested) {
              postResolutions();
              return;
            }
            this.post({
              type: 'explainActivity',
              text: `⚙ Retrying ${missing.length} unparsed conflict${missing.length === 1 ? '' : 's'}`,
            });
            void attempt(
              { system: base.system, user: `${base.user}\n\n${buildRetryAddendum(missing)}` },
              true,
            );
          },
        },
        started.token,
        started.tools,
      );
    };
    await attempt(base, false);
  }

  /** The drawer's follow-up chat — answers stream over the explain channel. */
  private async aiAsk(
    request: ExplainRequest,
    history: Array<{ question: string; answer: string }>,
    question: string,
  ): Promise<void> {
    const started = await this.startAiRequest(STEP_BUDGET_EXPLAIN);
    if (!started) {
      return;
    }
    await started.provider.stream(
      buildChatPrompt(request, history, question, started.context),
      this.drawerCallbacks(),
      started.token,
      started.tools,
    );
  }

  /**
   * Shared preamble: cancel any in-flight request, resolve the backend (or report
   * setup), and assemble the request's context — branch intent for the prompt,
   * tool executors when the backend can honor them.
   */
  private async startAiRequest(stepBudget: number): Promise<
    | {
        provider: Exclude<ExplainProvider, { kind: 'unconfigured' }>;
        token: vscode.CancellationToken;
        context: PromptContext;
        tools: StreamToolOptions | undefined;
      }
    | undefined
  > {
    this.cancelExplain();
    const cancellation = new vscode.CancellationTokenSource();
    this.explainCancellation = cancellation;
    const provider = await getExplainProvider(this.context);
    if (provider.kind === 'unconfigured') {
      this.post({
        type: 'explainError',
        message: 'No AI backend is configured.',
        unconfigured: true,
      });
      return undefined;
    }
    if (cancellation.token.isCancellationRequested) {
      return undefined;
    }
    this.subjects ??= await branchSubjects(this.repoRoot).catch(() => ({
      yours: [],
      theirs: [],
    }));
    const context: PromptContext = {
      subjects: this.subjects,
      toolsAvailable: provider.supportsTools,
    };
    const tools = provider.supportsTools
      ? { executors: createToolExecutors(this.repoRoot), stepBudget }
      : undefined;
    return { provider, token: cancellation.token, context, tools };
  }

  private cancelExplain(): void {
    this.explainCancellation?.cancel();
    this.explainCancellation?.dispose();
    this.explainCancellation = undefined;
  }

  /**
   * Writes the result and marks the file resolved.
   *
   * Applying with conflicts still untouched would stage a file containing the base text
   * where a decision belonged — quietly discarding both sides' work — so that needs an
   * explicit confirmation rather than a silent success.
   */
  private async apply(content: string, eol: Eol): Promise<void> {
    const unresolved = this.latestState?.unresolvedConflicts ?? 0;
    if (unresolved > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `${unresolved} conflict${unresolved === 1 ? '' : 's'} in "${this.relativePath}" ${
          unresolved === 1 ? 'is' : 'are'
        } still unresolved. Applying now keeps the original version for ${
          unresolved === 1 ? 'it' : 'them'
        }.`,
        { modal: true },
        'Apply Anyway',
      );
      if (proceed !== 'Apply Anyway') {
        this.post({ type: 'applyResult', ok: false, error: 'cancelled' });
        return;
      }
    }

    try {
      await applyResolved(this.repoRoot, this.relativePath, content, eol, this.hadBom);
      // The work is in git now; the crash-safety copy would only offer stale state.
      await this.context.workspaceState.update(this.workKey(), undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({ type: 'applyResult', ok: false, error: detail });
      void vscode.window.showErrorMessage(`Merge Forge: could not apply — ${detail}`);
      return;
    }

    this.panel.dispose();
    await this.reportProgress();
  }

  /** Tells the user where the merge stands, and keeps the loop going to the next file. */
  private async reportProgress(): Promise<void> {
    const remaining = await listConflicted(this.repoRoot).catch(() => undefined);
    if (remaining === undefined) {
      return;
    }
    if (remaining.length === 0) {
      void vscode.window.showInformationMessage(
        `Resolved "${this.relativePath}" — all conflicts resolved, ready to commit.`,
      );
      return;
    }
    const next = vscode.Uri.file(join(this.repoRoot, remaining[0]!));
    if (readAutoAdvance()) {
      // Keyboard-driven loop: straight into the next conflicted file, no stop.
      await vscode.commands.executeCommand('mergeForge.resolveThis', next);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Resolved "${this.relativePath}" — ${remaining.length} conflicted file${
        remaining.length === 1 ? '' : 's'
      } left.`,
      'Next Conflict',
    );
    if (choice === 'Next Conflict') {
      await vscode.commands.executeCommand('mergeForge.resolveThis', next);
    }
  }

  /** Closes without touching the conflicted file, so the merge can be restarted. */
  private async abort(): Promise<void> {
    if (this.latestState?.dirty) {
      const discard = await vscode.window.showWarningMessage(
        `Discard your work on "${this.relativePath}"? The file keeps its conflict markers.`,
        { modal: true },
        'Discard',
      );
      if (discard !== 'Discard') {
        return;
      }
      // An explicit discard should not resurrect as a restore offer next time.
      await this.context.workspaceState.update(this.workKey(), undefined);
    }
    this.panel.dispose();
  }

  private workKey(): string {
    return `mergeForge.work.${this.relativePath}`;
  }
}

/** What crash-safety persists per file: the snapshot plus its validity fingerprint. */
interface StoredWork {
  inputsHash: string;
  snapshot: WorkSnapshot;
  savedAt: number;
}

function readEolSetting(): EolSetting {
  const value = vscode.workspace.getConfiguration('mergeForge').get<string>('lineEnding', 'auto');
  return value === 'lf' || value === 'crlf' ? value : 'auto';
}

function readAutoApply(): boolean {
  return vscode.workspace
    .getConfiguration('mergeForge')
    .get<boolean>('autoApplyNonConflicting', false);
}

function readAutoAdvance(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoAdvance', false);
}

/** The user's editor font — the panes should feel like their editor, not ours. */
function readEditorFont(): { size: number; family: string; ligatures: boolean } {
  const editor = vscode.workspace.getConfiguration('editor');
  return {
    size: editor.get<number>('fontSize', 12),
    family: editor.get<string>('fontFamily', ''),
    ligatures: editor.get<boolean | string>('fontLigatures', false) === true,
  };
}

/** Reuses VS Code's own filename→language mapping, which Monaco's ids line up with. */
async function detectLanguageId(uri: vscode.Uri): Promise<string> {
  try {
    return (await vscode.workspace.openTextDocument(uri)).languageId;
  } catch {
    return 'plaintext';
  }
}

/**
 * A delete/modify conflict has nothing to show in three panes — one side has no file at
 * all — so offer the only two decisions that exist instead of an empty editor.
 */
async function showUnsupported(reason: UnsupportedReason, relativePath: string): Promise<void> {
  if (reason === 'binary') {
    void vscode.window.showWarningMessage(
      `Merge Forge: "${relativePath}" is a binary file — there is no line-by-line merge to show. ` +
        'Pick a side from the Source Control view, or resolve it with `git checkout --ours/--theirs`.',
    );
    return;
  }
  if (reason === 'tooLarge') {
    void vscode.window.showWarningMessage(
      `Merge Forge: "${relativePath}" is over 10 MB — too large for the visual merge editor. ` +
        'Resolve it in a plain editor or from the command line.',
    );
    return;
  }
  const deletedBy = reason === 'deletedByThem' ? 'the incoming branch' : 'your branch';
  void vscode.window.showWarningMessage(
    `Merge Forge: "${relativePath}" was deleted by ${deletedBy} and modified on the other side. ` +
      'Resolve it from the Source Control view by keeping or deleting the file.',
  );
}
