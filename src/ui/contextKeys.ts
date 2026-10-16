import { join } from 'node:path';
import * as vscode from 'vscode';
import { listConflicted } from '../git/conflicts';
import { findRepoRoot } from '../git/repoContext';

/** A file mid-merge always contains this marker; cheap to spot without parsing. */
const CONFLICT_MARKER = /^<{7} /m;

/**
 * Keeps the `when`-clause context keys in step with the repository.
 *
 * Menus are driven off these rather than a command that checks and then bails, so the
 * "Resolve in Merge Forge" entries simply don't appear on files that aren't conflicted.
 */
export class ContextKeys {
  private conflicted: string[] = [];
  private repoRoot: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Fires after every refresh, so every other affordance (CodeLens, status cluster,
     * Conflicts dialog) follows this one .git/index watcher. */
    private readonly onDidRefresh?: (
      conflictedAbsolutePaths: string[],
      repoRoot: string | undefined,
    ) => void,
  ) {}

  register(): void {
    // The index changes on merge, rebase, `git add`, and abort alike — watching the file
    // catches all of them without depending on the built-in git extension being present.
    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
    watcher.onDidChange(() => void this.refresh());
    watcher.onDidCreate(() => void this.refresh());
    watcher.onDidDelete(() => void this.refresh());

    this.context.subscriptions.push(
      watcher,
      vscode.window.onDidChangeActiveTextEditor((editor) => this.refreshActiveEditor(editor)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );
    void this.refresh();
  }

  /** Re-reads the conflicted set and republishes the keys the menus depend on. */
  async refresh(): Promise<void> {
    this.repoRoot = await this.findRoot();
    this.conflicted = this.repoRoot ? await listConflicted(this.repoRoot).catch(() => []) : [];
    const absolute = this.repoRoot ? this.conflicted.map((path) => join(this.repoRoot!, path)) : [];

    await setContext('mergeForge.hasConflicts', this.conflicted.length > 0);
    await setContext('mergeForge.conflictedPaths', absolute);
    this.refreshActiveEditor(vscode.window.activeTextEditor);
    this.onDidRefresh?.(absolute, this.repoRoot);
  }

  /**
   * Decides whether the editor title button shows. The marker scan is limited to files
   * git already calls conflicted, so it never scans the whole workspace.
   */
  private refreshActiveEditor(editor: vscode.TextEditor | undefined): void {
    const path = editor?.document.uri.fsPath;
    const isConflicted =
      path !== undefined &&
      this.repoRoot !== undefined &&
      this.conflicted.some((relative) => join(this.repoRoot!, relative) === path);
    const hasMarkers = isConflicted && CONFLICT_MARKER.test(editor!.document.getText());
    void setContext('mergeForge.editorHasConflictMarkers', hasMarkers);
  }

  private async findRoot(): Promise<string | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await findRepoRoot(folder.uri.fsPath);
      if (root) {
        return root;
      }
    }
    return undefined;
  }
}

function setContext(key: string, value: unknown): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', key, value);
}
