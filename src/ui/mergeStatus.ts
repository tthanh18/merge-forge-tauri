import * as vscode from 'vscode';
import { detectOperation, getMergeBranches, type Operation } from '../git/repoContext';
import { abortOperation } from '../git/resolveOps';

/**
 * The merge indicator cluster — merge-forge's stand-in for JetBrains' floating pill,
 * which VS Code offers no surface for. Three status-bar items shown while a merge,
 * rebase, or cherry-pick is in progress (until commit or abort, not merely while
 * conflicts remain):
 *
 *   [ ⚠ Merging feature → main ]  [ » ]  [ × ]
 *
 * The pill and » open the Conflicts dialog; × aborts behind a modal confirmation.
 * The status-bar API only offers the theme's warning/error backgrounds — the × gets
 * error red, but there is no green for ».
 */
export class MergeStatusCluster {
  private readonly pill: vscode.StatusBarItem;
  private readonly resolve: vscode.StatusBarItem;
  private readonly abort: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    // Descending priorities keep the three items adjacent, in order.
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_002);
    this.pill.command = 'mergeForge.showConflicts';
    this.pill.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    this.resolve = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_001);
    this.resolve.text = '»';
    this.resolve.tooltip = 'Show conflicts and resolve them';
    this.resolve.command = 'mergeForge.showConflicts';

    this.abort = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_000);
    this.abort.text = '×';
    this.abort.tooltip = 'Abort — throw away all conflict resolutions';
    this.abort.command = 'mergeForge.abortMerge';
    this.abort.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

    context.subscriptions.push(this.pill, this.resolve, this.abort);
  }

  /** Re-reads the operation state and shows or hides the cluster accordingly. */
  async refresh(repoRoot: string | undefined, conflictCount = 0): Promise<void> {
    const operation = repoRoot ? await detectOperation(repoRoot) : undefined;
    if (!repoRoot || !operation || operation.kind === 'unknown') {
      this.hide();
      return;
    }
    const branches = await getMergeBranches(repoRoot);
    const verb =
      operation.kind === 'merge'
        ? 'Merging'
        : operation.kind === 'rebase'
          ? 'Rebasing'
          : 'Cherry-picking';
    // The live count is the pill's headline; the branch pair moves to the tooltip.
    this.pill.text =
      conflictCount > 0
        ? `$(warning) ${verb}: ${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`
        : `$(warning) ${verb}: all resolved`;
    this.pill.tooltip =
      `${verb} branch "${branches.theirs}" into "${branches.yours}" — ` +
      (conflictCount > 0
        ? 'click to show conflicts'
        : 'every file is resolved; commit (or continue) to finish');
    this.pill.show();
    this.resolve.show();
    this.abort.show();
  }

  private hide(): void {
    this.pill.hide();
    this.resolve.hide();
    this.abort.hide();
  }
}

/** The command behind the ×: confirm, abort the right operation kind, report. */
export async function confirmAndAbort(repoRoot: string, operation: Operation): Promise<boolean> {
  const noun =
    operation.kind === 'merge'
      ? 'merge'
      : operation.kind === 'rebase'
        ? 'rebase'
        : operation.kind === 'cherry-pick'
          ? 'cherry-pick'
          : 'operation';
  const choice = await vscode.window.showWarningMessage(
    `Abort the ${noun}? All conflict resolutions made so far will be lost.`,
    { modal: true },
    `Abort ${noun}`,
  );
  if (choice === undefined) {
    return false;
  }
  try {
    await abortOperation(repoRoot, operation.kind);
    void vscode.window.showInformationMessage(`Merge Forge: ${noun} aborted.`);
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Merge Forge: could not abort — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
