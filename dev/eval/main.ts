/**
 * Merge-replay eval: re-runs merge-forge's real AI resolve pipeline against merges
 * a human already resolved in a repo's history, and scores the AI's output against
 * the human's. Dev-only — launched by replay.mjs, never bundled into the extension.
 *
 * For each of the last N merge commits: check out parent 1 in a temp worktree,
 * re-run the merge to reproduce the conflicts, build the exact ExplainRequest the
 * webview would send (same chunker, same prompt builders, same tools, same
 * streaming code), apply the AI's resolutions, and diff against the merge commit.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createTwoFilesPatch } from 'diff';
import type { LanguageModel } from 'ai';
import { buildResolvePrompt, buildRetryAddendum } from '../../src/ai/prompt';
import { providerById, resolveModel } from '../../src/ai/providers';
import { parseResolutions } from '../../src/ai/resolveParser';
import {
  NEVER_CANCELLED,
  STEP_BUDGET_RESOLVE,
  streamViaAiSdk,
  type PromptPair,
} from '../../src/ai/sdkStream';
import { branchSubjects, createNodeExecutors } from '../../src/ai/toolHostNode';
import { git, gitText } from '../../src/git/gitCli';
import { listConflicted } from '../../src/git/conflicts';
import { loadMergeInputs } from '../../src/git/loadMerge';
import { computeChunks, joinLines, splitLines } from '../../src/merge/engine';
import { chunkTexts } from '../../src/merge/resolve';
import { normalizeEol } from '../../src/merge/lineEndings';
import type { ExplainRequest } from '../../src/protocol';

interface CaseResult {
  merge: string;
  file: string;
  conflicts: number;
  resolved: number;
  verdict: 'exact' | 'whitespace' | 'different' | 'error' | 'skipped';
  note?: string;
}

interface Args {
  repo: string;
  merges: number;
  provider: string;
  model: string;
  baseUrl: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = get('--repo');
  if (!repo) {
    console.error(
      'Usage: pnpm run eval -- --repo <path> [--merges N] [--provider anthropic|openai|deepseek|kimi|custom] [--model id] [--base-url url]',
    );
    process.exit(1);
  }
  return {
    repo: resolvePath(repo),
    merges: Number(get('--merges') ?? '10'),
    provider: get('--provider') ?? 'anthropic',
    model: get('--model') ?? 'auto',
    baseUrl: get('--base-url') ?? '',
    out: resolvePath(get('--out') ?? 'dev/eval/out'),
  };
}

const KEY_ENVS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  custom: 'CUSTOM_API_KEY',
};

function buildModel(args: Args): { model: LanguageModel; label: string } {
  const spec = providerById(args.provider);
  if (!spec) {
    throw new Error(`unknown provider "${args.provider}"`);
  }
  const apiKey = process.env['MERGE_FORGE_EVAL_KEY'] ?? process.env[KEY_ENVS[spec.id] ?? ''] ?? '';
  const modelId = resolveModel(args.model, spec, args.model === 'auto' ? '' : args.model);
  if (spec.id === 'anthropic') {
    if (!apiKey) {
      throw new Error('set ANTHROPIC_API_KEY or MERGE_FORGE_EVAL_KEY');
    }
    return { model: createAnthropic({ apiKey })(modelId), label: spec.label };
  }
  const baseURL = spec.baseUrl ?? args.baseUrl;
  if (!baseURL || modelId === '') {
    throw new Error('custom provider needs --base-url and --model');
  }
  return {
    model: createOpenAICompatible({ name: spec.id, baseURL, apiKey: apiKey || 'not-needed' })(
      modelId,
    ),
    label: spec.label,
  };
}

/** Same language detection idea as the extension, minus vscode: by extension. */
function languageIdFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    vue: 'vue',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

/** The same one-retry resolve loop MergePanel runs, over the same streaming code. */
async function resolveWithAi(
  model: LanguageModel,
  label: string,
  request: ExplainRequest,
  prompt: PromptPair,
  worktree: string,
  onActivity: (text: string) => void,
): Promise<{ collected: Map<number, string>; error?: string }> {
  const expected = request.conflicts.map((c) => c.index);
  const collected = new Map<number, string>();
  let lastError: string | undefined;

  const attempt = async (user: string): Promise<void> => {
    let accumulated = '';
    await streamViaAiSdk(
      model,
      label,
      { system: prompt.system, user },
      {
        onDelta: (text) => {
          accumulated += text;
        },
        onActivity,
        onDone: () => {
          for (const [index, text] of parseResolutions(accumulated, expected)) {
            if (!collected.has(index)) {
              collected.set(index, text);
            }
          }
        },
        onError: (message) => {
          lastError = message;
        },
      },
      NEVER_CANCELLED,
      { executors: createNodeExecutors(worktree), stepBudget: STEP_BUDGET_RESOLVE },
    );
  };

  await attempt(prompt.user);
  const missing = expected.filter((i) => !collected.has(i));
  if (missing.length > 0 && !lastError) {
    onActivity(`⚙ Retrying ${missing.length} unparsed conflict(s)`);
    await attempt(`${prompt.user}\n\n${buildRetryAddendum(missing)}`);
  }
  return { collected, ...(lastError ? { error: lastError } : {}) };
}

/** Applies resolutions bottom-up onto the base document, like the webview does. */
function applyResolutions(
  base: string,
  request: ExplainRequest,
  byIndex: Map<number, string>,
): string {
  const lines = splitLines(base);
  const ordered = [...request.conflicts].sort((a, b) => b.resultStart - a.resultStart);
  for (const conflict of ordered) {
    const text = byIndex.get(conflict.index);
    if (text === undefined) {
      continue;
    }
    lines.splice(
      conflict.resultStart,
      conflict.resultEnd - conflict.resultStart,
      ...splitLines(text),
    );
  }
  return joinLines(lines);
}

function stripTrailingWs(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n+$/, '\n');
}

async function evalOneFile(
  args: Args,
  model: { model: LanguageModel; label: string },
  merge: string,
  worktree: string,
  file: string,
): Promise<CaseResult> {
  const inputs = await loadMergeInputs(worktree, file, 'auto');
  if (inputs.unsupported) {
    return { merge, file, conflicts: 0, resolved: 0, verdict: 'skipped', note: 'delete/modify' };
  }
  const { base, left, right, labels, filePath } = inputs.payload;
  const chunks = computeChunks(base, left, right);
  const conflictChunks = chunks.filter((c) => c.kind === 'conflict');
  if (conflictChunks.length === 0) {
    return { merge, file, conflicts: 0, resolved: 0, verdict: 'skipped', note: 'no red conflicts' };
  }
  const request: ExplainRequest = {
    filePath,
    languageId: languageIdFor(file),
    labels,
    resultText: base,
    conflicts: conflictChunks.map((chunk, i) => {
      const texts = chunkTexts(chunk, base, left, right);
      return {
        index: i + 1,
        chunkId: chunk.id,
        baseText: texts.base.join(''),
        leftText: texts.left.join(''),
        rightText: texts.right.join(''),
        resultStart: chunk.base.start,
        resultEnd: chunk.base.end,
      };
    }),
  };
  const subjects = await branchSubjects(worktree).catch(() => ({ yours: [], theirs: [] }));
  const prompt = buildResolvePrompt(request, undefined, { subjects, toolsAvailable: true });
  const { collected, error } = await resolveWithAi(
    model.model,
    model.label,
    request,
    prompt,
    worktree,
    (text) => console.log(`      ${text}`),
  );
  if (error) {
    return {
      merge,
      file,
      conflicts: request.conflicts.length,
      resolved: collected.size,
      verdict: 'error',
      note: error,
    };
  }

  const candidate = applyResolutions(base, request, collected);
  const human = normalizeEol((await git(worktree, ['show', `${merge}:${file}`])).toString('utf8'));
  let verdict: CaseResult['verdict'];
  if (candidate === human) {
    verdict = 'exact';
  } else if (stripTrailingWs(candidate) === stripTrailingWs(human)) {
    verdict = 'whitespace';
  } else {
    verdict = 'different';
    const patch = createTwoFilesPatch(`human/${file}`, `ai/${file}`, human, candidate);
    const slug = `${merge.slice(0, 8)}-${file.replace(/[^a-zA-Z0-9.]+/g, '_')}`;
    writeFileSync(join(args.out, `${slug}.diff`), patch);
  }
  return {
    merge,
    file,
    conflicts: request.conflicts.length,
    resolved: collected.size,
    verdict,
  };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const model = buildModel(args);
  mkdirSync(args.out, { recursive: true });

  const mergeList = (
    await gitText(args.repo, ['rev-list', '--merges', '-n', String(args.merges), 'HEAD'])
  )
    .split('\n')
    .filter(Boolean);
  console.log(`Replaying ${mergeList.length} merge commit(s) from ${args.repo}\n`);

  const results: CaseResult[] = [];
  for (const merge of mergeList) {
    const parents = (await gitText(args.repo, ['rev-list', '--parents', '-n', '1', merge]))
      .split(/\s+/)
      .slice(1);
    if (parents.length !== 2) {
      continue; // octopus merges are out of scope
    }
    const [p1, p2] = parents as [string, string];
    const worktree = join(tmpdir(), `mf-eval-${merge.slice(0, 8)}-${Date.now()}`);
    await gitText(args.repo, ['worktree', 'add', '--detach', worktree, p1]);
    try {
      let conflicted: string[] = [];
      try {
        execFileSync('git', ['merge', '--no-commit', '--no-ff', p2], {
          cwd: worktree,
          stdio: 'pipe',
        });
      } catch {
        conflicted = await listConflicted(worktree);
      }
      if (conflicted.length === 0) {
        console.log(`  ${merge.slice(0, 8)}: merged cleanly, skipped`);
        continue;
      }
      console.log(`  ${merge.slice(0, 8)}: ${conflicted.length} conflicted file(s)`);
      for (const file of conflicted) {
        try {
          const result = await evalOneFile(args, model, merge, worktree, file);
          results.push(result);
          console.log(
            `    ${file}: ${result.verdict}` +
              ` (${result.resolved}/${result.conflicts} resolved${result.note ? `, ${result.note}` : ''})`,
          );
        } catch (error) {
          results.push({
            merge,
            file,
            conflicts: 0,
            resolved: 0,
            verdict: 'error',
            note: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: worktree, stdio: 'pipe' });
      } catch {
        // no merge in progress
      }
      try {
        await gitText(args.repo, ['worktree', 'remove', '--force', worktree]);
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
  }

  const scored = results.filter((r) => r.verdict !== 'skipped');
  const count = (v: CaseResult['verdict']): number => scored.filter((r) => r.verdict === v).length;
  console.log('\n=== Summary ===');
  console.log(`cases:      ${scored.length}`);
  console.log(`exact:      ${count('exact')}`);
  console.log(`whitespace: ${count('whitespace')}`);
  console.log(`different:  ${count('different')} (diffs in ${args.out})`);
  console.log(`error:      ${count('error')}`);
  writeFileSync(join(args.out, 'results.json'), JSON.stringify(results, null, 2));
}
