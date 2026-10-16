import type { ExplainRequest } from '../protocol';

/** Per-side character cap; conflicts larger than this are code dumps, not questions. */
export const SIDE_TEXT_CAP = 4000;

/** Result documents up to this size are inlined whole; larger ones become windows. */
export const FILE_CONTEXT_CAP = 30000;

/** Lines of context on each side of a conflict when windowing a large document. */
export const CONTEXT_WINDOW_LINES = 30;

/**
 * Optional host-side enrichments: branch intent computed from git, and whether
 * the request runs with tools (which changes what the system prompt promises).
 */
export interface PromptContext {
  subjects?: { yours: string[]; theirs: string[] };
  toolsAvailable?: boolean;
}

const TOOLS_GUIDANCE = `

You have read-only tools to inspect the repository:
- readFile: read any workspace file (optionally a line range) — check imports, types, and neighbors.
- searchCode: find where an identifier is used, so the resolution matches its callers.
- gitContext: list the commits unique to each branch, or one commit's diff — each side's intent.
- findSymbol: locate a symbol's definition via the language server.
Use them when the conflict references code you cannot see; do not guess at symbols you can look up.
Keep tool use focused — a few targeted calls, then answer.`;

function withTools(system: string, context?: PromptContext): string {
  return context?.toolsAvailable ? system + TOOLS_GUIDANCE : system;
}

const SYSTEM_PROMPT = `You are a senior software engineer helping a teammate resolve a three-way Git merge.
For each conflict you receive the common ancestor (BASE) and the two branch versions.

For every conflict, under a "### Conflict N" heading:
1. Say in one or two sentences what each branch changed relative to BASE.
2. Explain why the two changes collide.
3. Suggest a concrete resolution — quote the merged code in a fenced block when it is short,
   or describe precisely which side to take and what to carry over from the other.

Be concise and practical. If the two sides are compatible (e.g. both added independent code),
say so and show how to combine them. Use markdown. Do not restate the inputs at length.
Cover every conflict you are given — never stop after the first one.`;

function fence(text: string, cap = SIDE_TEXT_CAP): string {
  if (text === '') {
    return '(no lines — deleted)';
  }
  const capped = text.length > cap ? `${text.slice(0, cap)}\n…truncated…\n` : text;
  const body = capped.endsWith('\n') ? capped : `${capped}\n`;
  return `\`\`\`\n${body}\`\`\``;
}

/** "Branch intent" — each side's commit subjects, the why behind the collision. */
function branchIntentSection(request: ExplainRequest, context?: PromptContext): string[] {
  const subjects = context?.subjects;
  if (!subjects || (subjects.yours.length === 0 && subjects.theirs.length === 0)) {
    return [];
  }
  const lines: string[] = ['Branch intent (commit subjects unique to each side):'];
  if (subjects.yours.length > 0) {
    lines.push(`YOURS (${request.labels.left}):`, ...subjects.yours.map((s) => `- ${s}`));
  }
  if (subjects.theirs.length > 0) {
    lines.push(`THEIRS (${request.labels.right}):`, ...subjects.theirs.map((s) => `- ${s}`));
  }
  lines.push('');
  return lines;
}

/**
 * The rich baseline: the whole result document when small, else merged
 * ±CONTEXT_WINDOW_LINES windows around each conflict, labeled with 1-based lines.
 */
function fileContextSection(request: ExplainRequest): string[] {
  const text = request.resultText;
  if (text === '') {
    return [];
  }
  const intro =
    'Current merge result document (the conflict regions below are still unresolved in it):';
  if (text.length <= FILE_CONTEXT_CAP) {
    return [intro, fence(text, FILE_CONTEXT_CAP), ''];
  }
  const docLines = text.split('\n');
  const windows = request.conflicts
    .map((c) => ({
      start: Math.max(0, c.resultStart - CONTEXT_WINDOW_LINES),
      end: Math.min(docLines.length, c.resultEnd + CONTEXT_WINDOW_LINES),
    }))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  const lines = [intro.replace('document', 'document — excerpts around each conflict')];
  for (const w of merged) {
    lines.push(
      `Lines ${w.start + 1}–${w.end}:`,
      fence(docLines.slice(w.start, w.end).join('\n'), FILE_CONTEXT_CAP),
      '',
    );
  }
  return lines;
}

/** The shared header + per-conflict BASE/YOURS/THEIRS sections. */
function conflictSections(request: ExplainRequest, context?: PromptContext): string[] {
  const lines: string[] = [
    `File: \`${request.filePath}\` (language: ${request.languageId})`,
    `Merging **${request.labels.right}** (theirs) into **${request.labels.left}** (yours).`,
    `The file has ${request.conflicts.length} unresolved conflict${
      request.conflicts.length === 1 ? '' : 's'
    }.`,
    '',
    ...branchIntentSection(request, context),
    ...fileContextSection(request),
  ];
  for (const conflict of request.conflicts) {
    lines.push(
      `## Conflict ${conflict.index}`,
      '',
      'BASE (common ancestor):',
      fence(conflict.baseText),
      '',
      `YOURS (${request.labels.left}):`,
      fence(conflict.leftText),
      '',
      `THEIRS (${request.labels.right}):`,
      fence(conflict.rightText),
      '',
    );
  }
  return lines;
}

/**
 * Builds the system/user prompt pair for a whole-file conflict explanation.
 * Pure and side-effect free so it can be unit-tested; providers own the transport.
 */
export function buildExplainPrompt(
  request: ExplainRequest,
  context?: PromptContext,
): { system: string; user: string } {
  const lines = conflictSections(request, context);
  // The explicit count keeps a model from quietly stopping after the first section.
  lines.push(
    `Your answer must contain exactly ${request.conflicts.length} "### Conflict" sections — ` +
      'one per conflict above, in order.',
  );
  return { system: withTools(SYSTEM_PROMPT, context), user: lines.join('\n') };
}

const RESOLVE_SYSTEM_PROMPT = `You are an expert Git merge resolver. For each conflict you receive the
common ancestor (BASE) and the two branch versions; your job is to produce the merged code a careful
engineer would write — combining compatible changes, choosing the better implementation when they
genuinely collide, and never dropping work from either side without reason.

Output format — this is machine-parsed, follow it exactly:
For each conflict N, output ONLY:
<<<RESOLVED N>>>
<the complete merged replacement for that conflict region>
<<<END N>>>

Rules:
- The content between the markers replaces the conflict region verbatim: real code only —
  no conflict markers, no markdown fences, no commentary, no explanations.
- Preserve the file's existing indentation and style.
- An intentionally empty region (both sides should be dropped) is an empty block.
- Do not output anything outside the blocks.`;

/**
 * The resolution counterpart of the explain prompt: same conflict sections, but the
 * answer is the machine-parsed delimiter protocol (see `resolveParser.ts`). A prior
 * explanation, when present, is included so the merge matches what was suggested.
 */
export function buildResolvePrompt(
  request: ExplainRequest,
  explanation?: string,
  context?: PromptContext,
): { system: string; user: string } {
  const lines = conflictSections(request, context);
  if (explanation && explanation.trim() !== '') {
    lines.push(
      'Earlier analysis of these conflicts (follow its suggestions):',
      '',
      explanation,
      '',
    );
  }
  const count = request.conflicts.length;
  lines.push(
    `Output exactly ${count} block${count === 1 ? '' : 's'}, one per conflict above, in order:`,
    ...request.conflicts.map((c) => `<<<RESOLVED ${c.index}>>> … <<<END ${c.index}>>>`),
  );
  return { system: withTools(RESOLVE_SYSTEM_PROMPT, context), user: lines.join('\n') };
}

/**
 * Appended to a second resolve attempt when the first answer had missing or
 * unparseable blocks — one retry, then whatever parsed is applied.
 */
export function buildRetryAddendum(missingIndexes: number[]): string {
  const list = missingIndexes.join(', ');
  return (
    `Your previous output was missing or unparseable for conflict${
      missingIndexes.length === 1 ? '' : 's'
    } ${list}. ` +
    'Answer again with ONLY the delimiter blocks (<<<RESOLVED N>>> … <<<END N>>>), ' +
    'exactly as specified — no commentary, no fences.'
  );
}

const CHAT_SYSTEM_PROMPT = `You are a senior engineer helping a teammate think through a three-way Git
merge. You receive the file's unresolved conflicts (BASE plus both branch versions), possibly an
earlier conversation, and a new question. Answer the question directly and concisely in markdown,
grounded in the conflict code — quote the relevant lines when it helps. If the question asks what to
do, give a concrete recommendation.`;

/**
 * The drawer's follow-up chat: conflicts + the conversation so far + the new question,
 * folded into a single prompt so every backend (including vscode.lm) can serve it.
 */
export function buildChatPrompt(
  request: ExplainRequest,
  history: ReadonlyArray<{ question: string; answer: string }>,
  question: string,
  context?: PromptContext,
): { system: string; user: string } {
  const lines = conflictSections(request, context);
  if (history.length > 0) {
    lines.push('Conversation so far:', '');
    for (const turn of history) {
      lines.push(`Q: ${turn.question}`, '', `A: ${turn.answer}`, '');
    }
  }
  lines.push('New question:', question);
  return { system: withTools(CHAT_SYSTEM_PROMPT, context), user: lines.join('\n') };
}
