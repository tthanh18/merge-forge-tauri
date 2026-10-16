import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// provider.ts imports 'vscode' at module scope; explainViaAiSdk itself never calls it,
// so a bare stub is enough to load the module outside an extension host.
vi.mock('vscode', () => ({}));

import { buildExplainPrompt, buildResolvePrompt } from '../src/ai/prompt';
import { streamViaAiSdk, type ExplainCallbacks } from '../src/ai/provider';
import { parseResolutions } from '../src/ai/resolveParser';
import type { ExplainRequest } from '../src/protocol';

/**
 * Drives the real AI SDK streaming path against a local OpenAI-compatible SSE stub —
 * the same protocol DeepSeek, Kimi, OpenAI, and Custom endpoints speak — so request
 * shape, delta forwarding, completion, and error mapping are verified without any key.
 */

const SSE_CHUNKS = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];

let server: Server;
let baseUrl = '';
/** Behavior switch per request, keyed by the model id the client asks for. */
let lastRequestBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      lastRequestBody = body;
      const wantsError = body.includes('"model":"error-model"');
      if (wantsError) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      const wantsTruncation = body.includes('"model":"truncating-model"');
      const wantsResolution = body.includes('"model":"resolve-model"');
      // Tool round-trip: first request answers with a tool call; the follow-up
      // (recognizable by the tool-role message) answers with text.
      const wantsToolCall =
        body.includes('"model":"tool-model"') && !body.includes('"role":"tool"');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const common = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'stub',
      };
      const chunks = wantsToolCall
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'searchCode', arguments: '{"query":"greet"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : wantsResolution
          ? [
              {
                choices: [
                  { index: 0, delta: { role: 'assistant', content: '<<<RESOLVED 1>>>\nmer' } },
                ],
              },
              { choices: [{ index: 0, delta: { content: 'ged();\n<<<END 1>>>' } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ]
          : wantsTruncation
            ? SSE_CHUNKS.map((chunk) =>
                chunk.choices[0]?.finish_reason === 'stop'
                  ? { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }
                  : chunk,
              )
            : SSE_CHUNKS;
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ ...common, ...chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

const request: ExplainRequest = {
  filePath: 'src/a.ts',
  languageId: 'typescript',
  labels: { left: 'feature', right: 'main' },
  resultText: 'b\n',
  conflicts: [
    {
      index: 1,
      chunkId: 10,
      baseText: 'a\n',
      leftText: 'b\n',
      rightText: 'c\n',
      resultStart: 0,
      resultEnd: 1,
    },
  ],
};

function token(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as never;
}

function collect() {
  const deltas: string[] = [];
  const events: string[] = [];
  const activity: string[] = [];
  const callbacks: ExplainCallbacks = {
    onDelta: (text) => deltas.push(text),
    onActivity: (text) => activity.push(text),
    onDone: (truncated) => events.push(truncated ? 'done:truncated' : 'done'),
    onError: (message) => events.push(`error:${message}`),
  };
  return { deltas, events, activity, callbacks };
}

function model(modelId: string) {
  return createOpenAICompatible({ name: 'stub', baseURL: baseUrl, apiKey: 'test' })(modelId);
}

describe('explainViaAiSdk against a local OpenAI-compatible stub', () => {
  test('forwards streamed deltas and finishes with onDone', async () => {
    const { deltas, events, callbacks } = collect();
    await streamViaAiSdk(
      model('ok-model'),
      'Stub',
      buildExplainPrompt(request),
      callbacks,
      token(),
    );
    expect(deltas.join('')).toBe('Hello world');
    expect(events).toEqual(['done']);
    // The request carried our prompt: system + the conflict texts.
    expect(lastRequestBody).toContain('three-way');
    expect(lastRequestBody).toContain('feature');
  });

  test('maps a 401 to the invalid-key message, no onDone', async () => {
    const { events, callbacks } = collect();
    await streamViaAiSdk(
      model('error-model'),
      'Stub',
      buildExplainPrompt(request),
      callbacks,
      token(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('Invalid Stub API key');
    expect(events[0]).toContain('Set AI Provider & API Key');
  });

  test("a 'length' finish is surfaced as a truncated completion", async () => {
    const { deltas, events, callbacks } = collect();
    await streamViaAiSdk(
      model('truncating-model'),
      'Stub',
      buildExplainPrompt(request),
      callbacks,
      token(),
    );
    expect(deltas.join('')).toBe('Hello world');
    expect(events).toEqual(['done:truncated']);
  });

  test('the request carries an explicit output-token cap', async () => {
    const { callbacks } = collect();
    await streamViaAiSdk(
      model('ok-model'),
      'Stub',
      buildExplainPrompt(request),
      callbacks,
      token(),
    );
    expect(lastRequestBody).toContain('"max_tokens":16000');
  });

  test('resolve round-trip: streamed delimiter blocks parse into resolutions', async () => {
    const { deltas, events, callbacks } = collect();
    await streamViaAiSdk(
      model('resolve-model'),
      'Stub',
      buildResolvePrompt(request, '### Conflict 1\nCombine both.'),
      callbacks,
      token(),
    );
    expect(events).toEqual(['done']);
    // The stub streams a well-formed block; the same accumulate+parse the host does.
    const parsed = parseResolutions(
      deltas.join(''),
      request.conflicts.map((c) => c.index),
    );
    expect(parsed.get(1)).toBe('merged();\n');
    // The resolve prompt reached the wire with the analysis context.
    expect(lastRequestBody).toContain('RESOLVED');
    expect(lastRequestBody).toContain('Combine both.');
  });

  test('tool round-trip: the model calls a tool, our executor answers, text follows', async () => {
    const { deltas, events, activity, callbacks } = collect();
    let searched = '';
    await streamViaAiSdk(
      model('tool-model'),
      'Stub',
      buildExplainPrompt(request, { toolsAvailable: true }),
      callbacks,
      token(),
      {
        executors: {
          readFile: async () => 'unused',
          searchCode: async ({ query }) => {
            searched = query;
            return `hits for ${query}`;
          },
          gitContext: async () => 'unused',
          findSymbol: async () => 'unused',
        },
        stepBudget: 3,
      },
    );
    // Our executor ran with the model's arguments…
    expect(searched).toBe('greet');
    // …the drawer got a live activity line…
    expect(activity).toContain('⚙ Searched "greet"');
    // …the tool result went back over the wire in the follow-up request…
    expect(lastRequestBody).toContain('hits for greet');
    expect(lastRequestBody).toContain('"role":"tool"');
    // …and the loop finished with the second step's text answer.
    expect(deltas.join('')).toBe('Hello world');
    expect(events).toEqual(['done']);
    // The request advertised the four tools.
    expect(lastRequestBody).toContain('gitContext');
    expect(lastRequestBody).toContain('findSymbol');
  });
});
