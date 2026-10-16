/**
 * The read-only tool set the AI can use while explaining or resolving conflicts.
 * This module is pure — specs, dispatch, and the activity-line formatter — so it
 * unit-tests without vscode; the actual executors live in `toolHost.ts` and are
 * injected. Both backends (AI SDK tool calling and vscode.lm tool calls) share it.
 */

// Output caps: a tool result is context for one decision, not a data dump.
export const READ_FILE_MAX_LINES = 400;
export const SEARCH_MAX_HITS = 30;
export const SEARCH_CONTEXT_LINES = 2;
export const GIT_MAX_SUBJECTS = 20;
export const GIT_DIFF_CAP = 8000;
export const SYMBOL_MAX_RESULTS = 20;

export type ToolName = 'readFile' | 'searchCode' | 'gitContext' | 'findSymbol';

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface SearchCodeInput {
  query: string;
}

export interface GitContextInput {
  side?: 'yours' | 'theirs';
  commit?: string;
}

export interface FindSymbolInput {
  name: string;
}

/** Host-side implementations, injected so this module stays vscode-free. */
export interface ToolExecutors {
  readFile(input: ReadFileInput): Promise<string>;
  searchCode(input: SearchCodeInput): Promise<string>;
  gitContext(input: GitContextInput): Promise<string>;
  findSymbol(input: FindSymbolInput): Promise<string>;
}

export interface ToolSpec {
  name: ToolName;
  description: string;
  /** JSON Schema (draft-07 subset) — consumed verbatim by both backends. */
  inputSchema: object;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'readFile',
    description:
      `Read a file from the workspace (up to ${READ_FILE_MAX_LINES} lines per call). ` +
      'Use it to inspect imported modules, type definitions, or code adjacent to the conflict ' +
      'before deciding how to merge. Optionally pass a 1-based line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path, e.g. src/utils/date.ts',
        },
        startLine: { type: 'number', description: '1-based first line to read (optional)' },
        endLine: { type: 'number', description: '1-based last line to read (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'searchCode',
    description:
      `Search the workspace for a string or identifier (first ${SEARCH_MAX_HITS} hits, with ` +
      `${SEARCH_CONTEXT_LINES} context lines). Use it to find where a conflicting function or ` +
      'symbol is used, so the resolution matches its callers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exact text to search for (not a regex)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gitContext',
    description:
      'Summarize the commits unique to each branch of this merge (their subjects), or show one ' +
      "commit's diff when a hash is given. Use it to understand what each side was trying to do — " +
      'intent usually decides the merge.',
    inputSchema: {
      type: 'object',
      properties: {
        side: {
          type: 'string',
          enum: ['yours', 'theirs'],
          description: 'Limit the summary to one side (optional; default both)',
        },
        commit: { type: 'string', description: 'Commit hash to show the full diff of (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'findSymbol',
    description:
      "Look up a symbol's definition via the editor's language services (workspace symbols + a " +
      'peek at the definition site). More precise than text search for classes, functions, and types.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Symbol name, e.g. CreateMetricModal or formatMetric',
        },
      },
      required: ['name'],
    },
  },
];

function asObject(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

/** The drawer's activity line for a tool call: "⚙ Read src/utils/date.ts". */
export function describeToolCall(name: string, input: unknown): string {
  const args = asObject(input);
  switch (name) {
    case 'readFile': {
      if (typeof args['path'] !== 'string') {
        break;
      }
      const range =
        typeof args['startLine'] === 'number' && typeof args['endLine'] === 'number'
          ? `:${args['startLine']}–${args['endLine']}`
          : '';
      return `⚙ Read ${args['path']}${range}`;
    }
    case 'searchCode':
      if (typeof args['query'] === 'string') {
        return `⚙ Searched "${args['query']}"`;
      }
      break;
    case 'gitContext': {
      if (typeof args['commit'] === 'string' && args['commit'] !== '') {
        return `⚙ Git: commit ${args['commit'].slice(0, 7)}`;
      }
      const side = typeof args['side'] === 'string' ? args['side'] : 'branch';
      return `⚙ Git: ${side} history`;
    }
    case 'findSymbol':
      if (typeof args['name'] === 'string') {
        return `⚙ Looked up ${args['name']}`;
      }
      break;
  }
  return `⚙ ${name}`;
}

/**
 * Dispatches one tool call to its executor. Never throws: failures come back as
 * text the model can read and route around — a dead tool must not kill the stream.
 */
export async function runTool(
  executors: ToolExecutors,
  name: string,
  input: unknown,
): Promise<string> {
  const args = asObject(input);
  try {
    switch (name) {
      case 'readFile':
        return await executors.readFile(args as unknown as ReadFileInput);
      case 'searchCode':
        return await executors.searchCode(args as unknown as SearchCodeInput);
      case 'gitContext':
        return await executors.gitContext(args as unknown as GitContextInput);
      case 'findSymbol':
        return await executors.findSymbol(args as unknown as FindSymbolInput);
      default:
        return `Unknown tool "${name}" — available tools: readFile, searchCode, gitContext, findSymbol.`;
    }
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
