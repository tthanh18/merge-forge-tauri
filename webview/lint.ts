import * as ts from 'typescript';

/**
 * Self-contained syntax check of the merged result, run entirely in the webview so it
 * behaves identically in the VS Code panel and the Tauri desktop app — no host or
 * language-service round-trip required. TypeScript's parser reports precise, multi-error
 * syntax diagnostics for TS/JS/TSX/JSX; JSON is checked with JSON.parse. Every other
 * language returns `null` ("no checker available").
 */

export interface SyntaxIssue {
  /** 0-based start position. */
  startLine: number;
  startCharacter: number;
  /** 0-based end position (exclusive). */
  endLine: number;
  endCharacter: number;
  message: string;
}

/** Returns the syntax issues in `code`, or `null` when this file type isn't supported. */
export function checkSyntax(
  languageId: string,
  filePath: string,
  code: string,
): SyntaxIssue[] | null {
  if (isTypeScriptLike(languageId, filePath)) {
    return checkTypeScript(code, fileNameOf(filePath));
  }
  if (languageId === 'json') {
    return checkJson(code);
  }
  return null;
}

function isTypeScriptLike(languageId: string, filePath: string): boolean {
  const ext = extensionOf(filePath);
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return true;
  }
  if (ext === 'mts' || ext === 'cts' || ext === 'mjs' || ext === 'cjs') {
    return true;
  }
  return (
    languageId === 'typescript' ||
    languageId === 'javascript' ||
    languageId === 'typescriptreact' ||
    languageId === 'javascriptreact'
  );
}

function checkTypeScript(code: string, fileName: string): SyntaxIssue[] {
  const result = ts.transpileModule(code, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
    },
  });
  return (result.diagnostics ?? []).map((diagnostic) =>
    toIssue(code, diagnostic.start ?? 0, diagnostic.length ?? 0, diagnostic),
  );
}

function checkJson(code: string): SyntaxIssue[] {
  try {
    JSON.parse(code);
    return [];
  } catch (error) {
    return [jsonErrorToIssue(error)];
  }
}

function toIssue(
  code: string,
  start: number,
  length: number,
  diagnostic: ts.Diagnostic,
): SyntaxIssue {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const clampedStart = Math.min(start, code.length);
  const end = Math.min(Math.max(clampedStart + Math.max(length, 1), clampedStart + 1), code.length);
  const startPos = lineColumnAt(code, clampedStart);
  const endPos = lineColumnAt(code, end);
  return {
    startLine: startPos.line,
    startCharacter: startPos.character,
    endLine: endPos.line,
    endCharacter: endPos.character,
    message,
  };
}

/** Maps a character offset to its 0-based line and column. */
function lineColumnAt(code: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function jsonErrorToIssue(error: unknown): SyntaxIssue {
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = message.match(/line (\d+)/);
  const columnMatch = message.match(/column (\d+)/);
  if (lineMatch && columnMatch) {
    const line = Number(lineMatch[1]) - 1;
    const character = Number(columnMatch[1]) - 1;
    return {
      startLine: line,
      startCharacter: character,
      endLine: line,
      endCharacter: character + 1,
      message,
    };
  }
  return { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, message };
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() || 'result';
}

function extensionOf(filePath: string): string {
  const clean = filePath.replace(/[?#].*$/, '');
  const slash = clean.lastIndexOf('/');
  const dot = clean.lastIndexOf('.');
  return dot > slash ? clean.slice(dot + 1).toLowerCase() : '';
}
