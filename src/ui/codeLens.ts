import * as vscode from 'vscode';

/** Start of a conflict block written by git. */
const CONFLICT_START = /^<{7} /;

/**
 * Offers "Resolve in Merge Forge" directly above each conflict block.
 *
 * This is the entry point that meets people where they already are — staring at the
 * markers in the file — rather than expecting them to find a command first.
 */
export class ConflictCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly isConflicted: (uri: vscode.Uri) => boolean) {}

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isConflicted(document.uri)) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < document.lineCount; line++) {
      if (CONFLICT_START.test(document.lineAt(line).text)) {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: '$(git-merge) Resolve in Merge Forge',
            command: 'mergeForge.resolveThis',
            arguments: [document.uri],
          }),
        );
      }
    }
    return lenses;
  }
}
