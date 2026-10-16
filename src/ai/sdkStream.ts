/**
 * The AI SDK streaming path, kept free of any vscode import so the same code that
 * powers the extension's API-key backends also runs in the dev eval harness
 * (`dev/eval`). The extension passes a real `vscode.CancellationToken`, which
 * structurally satisfies `CancelToken`.
 */

import {
  APICallError,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type Tool,
} from 'ai';
import { describeToolCall, runTool, TOOL_SPECS, type ToolExecutors } from './tools';

/** A ready-to-send prompt; built by the callers (explain vs resolve) in prompt.ts. */
export interface PromptPair {
  system: string;
  user: string;
}

/** Tool-loop step budgets: how many rounds of tool calls before we force an answer. */
export const STEP_BUDGET_RESOLVE = 8;
export const STEP_BUDGET_EXPLAIN = 4;

export interface ExplainCallbacks {
  onDelta(text: string): void;
  /** A tool-use progress line for the drawer: "⚙ Read src/x.ts". */
  onActivity?(text: string): void;
  /** `truncated` is set when the model hit the output-token cap mid-answer. */
  onDone(truncated?: boolean): void;
  onError(message: string): void;
}

/** Enables the agentic tool loop for a request. */
export interface StreamToolOptions {
  executors: ToolExecutors;
  stepBudget: number;
}

/** The slice of vscode.CancellationToken this module actually needs. */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** A token that never cancels, for non-interactive callers like the eval script. */
export const NEVER_CANCELLED: CancelToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

/** Builds the AI SDK tool set: shared specs, activity lines emitted at call time. */
function aiSdkTools(options: StreamToolOptions, callbacks: ExplainCallbacks): Record<string, Tool> {
  const entries = TOOL_SPECS.map((spec) => [
    spec.name,
    tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
      // runTool never throws — failures return as text the model can read.
      execute: (input: unknown) => {
        callbacks.onActivity?.(describeToolCall(spec.name, input));
        return runTool(options.executors, spec.name, input);
      },
    }),
  ]);
  return Object.fromEntries(entries) as Record<string, Tool>;
}

/** One streaming path for every API-key provider, via the AI SDK. */
export async function streamViaAiSdk(
  model: LanguageModel,
  providerLabel: string,
  { system, user }: PromptPair,
  callbacks: ExplainCallbacks,
  token: CancelToken,
  toolOptions?: StreamToolOptions,
): Promise<void> {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed || token.isCancellationRequested) {
      return;
    }
    failed = true;
    callbacks.onError(describeError(error, providerLabel));
  };
  try {
    const result = streamText({
      model,
      system,
      prompt: user,
      // Generous cap: enough for many conflicts, but explicit so a hit is detectable.
      maxOutputTokens: 16000,
      abortSignal: controller.signal,
      ...(toolOptions
        ? {
            tools: aiSdkTools(toolOptions, callbacks),
            // +1: the budget counts tool rounds; the final step is the answer.
            stopWhen: stepCountIs(toolOptions.stepBudget + 1),
          }
        : {}),
      // The AI SDK reports stream errors here rather than throwing from textStream.
      onError: ({ error }) => fail(error),
    });
    for await (const delta of result.textStream) {
      if (token.isCancellationRequested) {
        return;
      }
      callbacks.onDelta(delta);
    }
    if (!failed && !token.isCancellationRequested) {
      const finishReason = await result.finishReason;
      callbacks.onDone(finishReason === 'length');
    }
  } catch (error) {
    fail(error);
  } finally {
    cancellation.dispose();
  }
}

function describeError(error: unknown, providerLabel: string): string {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) {
      return `Invalid ${providerLabel} API key — run "Merge Forge: Set AI Provider & API Key" to update it.`;
    }
    if (status === 429) {
      return `${providerLabel} API rate limit hit — wait a moment and try again.`;
    }
    return `${providerLabel} API error (${String(status ?? '?')}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
