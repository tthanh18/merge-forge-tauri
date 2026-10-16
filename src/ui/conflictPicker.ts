import * as vscode from 'vscode';
import { findRepoRoot } from '../git/repoContext';

/** The repo root for the current workspace, or undefined when there isn't one. */
export async function activeRepoRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const root = await findRepoRoot(active.fsPath);
    if (root) {
      return root;
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = await findRepoRoot(folder.uri.fsPath);
    if (root) {
      return root;
    }
  }
  return undefined;
}
