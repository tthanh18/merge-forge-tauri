/**
 * Extension-host tool executors: the node implementations plus `findSymbol`,
 * which needs the editor's language services and therefore lives behind vscode.
 */

import * as vscode from 'vscode';
import { SYMBOL_MAX_RESULTS, type ToolExecutors } from './tools';
import { createNodeExecutors } from './toolHostNode';

const PEEK_LINES = 10;

async function findSymbolExecutor(name: string): Promise<string> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('findSymbol needs a symbol name');
  }
  const symbols =
    (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      name,
    )) ?? [];
  if (symbols.length === 0) {
    return `No symbol provider results for "${name}" — try searchCode instead.`;
  }
  // Exact-name matches outrank fuzzy ones; the language server returns both.
  const ranked = [...symbols].sort((a, b) => Number(b.name === name) - Number(a.name === name));
  const top = ranked.slice(0, SYMBOL_MAX_RESULTS);
  const lines = top.map((s) => {
    const rel = vscode.workspace.asRelativePath(s.location.uri, false);
    return `${vscode.SymbolKind[s.kind]} ${s.name} — ${rel}:${s.location.range.start.line + 1}`;
  });

  // Peek at the best hit's definition site so the model sees real code, not a list.
  const best = top[0];
  if (best) {
    try {
      const doc = await vscode.workspace.openTextDocument(best.location.uri);
      const start = Math.max(0, best.location.range.start.line - 2);
      const end = Math.min(doc.lineCount, best.location.range.start.line + PEEK_LINES);
      const excerpt = doc.getText(new vscode.Range(start, 0, end, 0));
      lines.push(
        '',
        `Definition site (${vscode.workspace.asRelativePath(best.location.uri, false)}):`,
        excerpt,
      );
    } catch {
      // The list alone is still useful.
    }
  }
  return lines.join('\n');
}

/** All four executors, rooted at the merge's repository. */
export function createToolExecutors(repoRoot: string): ToolExecutors {
  return {
    ...createNodeExecutors(repoRoot),
    findSymbol: ({ name }) => findSymbolExecutor(name),
  };
}
