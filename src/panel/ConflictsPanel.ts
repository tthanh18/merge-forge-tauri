import { join } from 'node:path';
import * as vscode from 'vscode';
import { detectOperation, getMergeBranches } from '../git/repoContext';
import { acceptSide, listConflictStatuses } from '../git/resolveOps';
import type { ConflictsData, ConflictsToHostMessage, HostToConflictsMessage } from '../protocol';
import { getConflictsHtml } from './html';

/**
 * The Conflicts dialog host — JetBrains' file-list modal as a singleton webview tab.
 * It lists conflicted files with per-side statuses and runs whole-file resolutions;
 * per-chunk work is handed off to the three-pane MergePanel via `mergeForge.resolveThis`.
 */
export class ConflictsPanel {
  private static current: ConflictsPanel | undefined;
  /** High-water mark of conflicted files for the current operation. */
  private totalAtStart = 0;

  static show(context: vscode.ExtensionContext, repoRoot: string): void {
    if (ConflictsPanel.current) {
      ConflictsPanel.current.repoRoot = repoRoot;
      ConflictsPanel.current.panel.reveal();
      void ConflictsPanel.current.push();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mergeForge.conflicts',
      'Conflicts',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    ConflictsPanel.current = new ConflictsPanel(panel, context, repoRoot);
  }

  /** Live-updates the open dialog (if any) — called from the .git/index watcher. */
  static refresh(): void {
    void ConflictsPanel.current?.push();
  }

  static get isOpen(): boolean {
    return ConflictsPanel.current !== undefined;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private repoRoot: string,
  ) {
    this.panel.webview.html = getConflictsHtml(this.panel.webview, context.extensionUri);
    this.panel.onDidDispose(() => {
      ConflictsPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: ConflictsToHostMessage) =>
      this.onMessage(message),
    );
  }

  private post(message: HostToConflictsMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async push(): Promise<void> {
    const [files, branches, operation] = await Promise.all([
      listConflictStatuses(this.repoRoot),
      getMergeBranches(this.repoRoot),
      detectOperation(this.repoRoot),
    ]);
    // Reset the denominator when a new batch of conflicts appears from zero.
    if (this.totalAtStart === 0 || files.length > this.totalAtStart) {
      this.totalAtStart = files.length;
    }
    if (files.length === 0 && operation.kind === 'unknown') {
      this.totalAtStart = 0;
    }
    const payload: ConflictsData = {
      // Statuses come back in git stage terms (yours = stage 2). During a rebase the
      // presentation flips — the branch names already flip, so the columns must too.
      files: files.map((raw) => {
        const file = operation.swapPresentation
          ? { ...raw, yours: raw.theirs, theirs: raw.yours }
          : raw;
        return {
          ...file,
          // A side that deleted the file leaves nothing to show in three panes.
          mergeable: file.yours !== 'Deleted' && file.theirs !== 'Deleted',
        };
      }),
      branches,
      operation: operation.kind,
      totalAtStart: this.totalAtStart,
    };
    this.post({ type: 'conflicts', payload });
  }

  private async onMessage(message: ConflictsToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.push();
        break;
      case 'acceptSide': {
        const operation = await detectOperation(this.repoRoot);
        try {
          await acceptSide(
            this.repoRoot,
            message.payload.paths,
            message.payload.side,
            operation.swapPresentation,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Merge Forge: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The index watcher will also fire, but pushing now keeps the dialog snappy.
        await this.push();
        break;
      }
      case 'openMerge':
        await vscode.commands.executeCommand(
          'mergeForge.resolveThis',
          vscode.Uri.file(join(this.repoRoot, message.payload.path)),
        );
        break;
      case 'resolveDeleteModify':
        await this.resolveDeleteModify(message.payload.path);
        break;
      case 'close':
        this.panel.dispose();
        break;
    }
  }

  /**
   * The JetBrains keep-or-delete prompt for a delete/modify conflict: one side removed
   * the file, the other changed it — the two possible answers are named explicitly
   * instead of hiding behind "Accept Yours/Theirs".
   */
  private async resolveDeleteModify(path: string): Promise<void> {
    const [files, branches, operation] = await Promise.all([
      listConflictStatuses(this.repoRoot),
      getMergeBranches(this.repoRoot),
      detectOperation(this.repoRoot),
    ]);
    const raw = files.find((entry) => entry.path === path);
    if (!raw || (raw.yours !== 'Deleted' && raw.theirs !== 'Deleted')) {
      return; // resolved elsewhere in the meantime, or not a delete/modify row
    }
    // Same stage→presentation flip as push(): compare like with like.
    const file = operation.swapPresentation ? { yours: raw.theirs, theirs: raw.yours } : raw;
    const deletedByYours = file.yours === 'Deleted';
    const deletedBy = deletedByYours ? branches.yours : branches.theirs;
    const modifiedBy = deletedByYours ? branches.theirs : branches.yours;
    const choice = await vscode.window.showWarningMessage(
      `"${path}" was deleted in "${deletedBy}" and modified in "${modifiedBy}".`,
      { modal: true },
      'Keep Modified File',
      'Delete File',
    );
    if (choice === undefined) {
      return;
    }
    // Keep = take the side that modified it; Delete = take the side that removed it.
    const keep = choice === 'Keep Modified File';
    const side = keep === deletedByYours ? 'theirs' : 'yours';
    try {
      await acceptSide(this.repoRoot, [path], side, operation.swapPresentation);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Merge Forge: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.push();
  }
}
