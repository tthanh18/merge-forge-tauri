import { describe, expect, test } from 'vitest';
import { describeToolCall, runTool, TOOL_SPECS, type ToolExecutors } from '../src/ai/tools';

function executors(overrides: Partial<ToolExecutors> = {}): ToolExecutors {
  return {
    readFile: async ({ path }) => `contents of ${path}`,
    searchCode: async ({ query }) => `hits for ${query}`,
    gitContext: async ({ side }) => `history of ${side ?? 'both'}`,
    findSymbol: async ({ name }) => `definition of ${name}`,
    ...overrides,
  };
}

describe('TOOL_SPECS', () => {
  test('declares exactly the four read-only tools', () => {
    expect(TOOL_SPECS.map((s) => s.name).sort()).toEqual([
      'findSymbol',
      'gitContext',
      'readFile',
      'searchCode',
    ]);
  });

  test('every spec has a description and a JSON-schema object input', () => {
    for (const spec of TOOL_SPECS) {
      expect(spec.description.length).toBeGreaterThan(20);
      const schema = spec.inputSchema as { type: string; properties: object };
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeTypeOf('object');
    }
  });

  test('readFile schema requires path; searchCode requires query; findSymbol requires name', () => {
    const required = (name: string): string[] =>
      (TOOL_SPECS.find((s) => s.name === name)?.inputSchema as { required?: string[] }).required ??
      [];
    expect(required('readFile')).toContain('path');
    expect(required('searchCode')).toContain('query');
    expect(required('findSymbol')).toContain('name');
    // gitContext with no arguments is valid: "summarize both sides".
    expect(required('gitContext')).toEqual([]);
  });
});

describe('describeToolCall', () => {
  test('readFile shows the path, with a line range when given', () => {
    expect(describeToolCall('readFile', { path: 'src/utils/date.ts' })).toBe(
      '⚙ Read src/utils/date.ts',
    );
    expect(
      describeToolCall('readFile', { path: 'src/utils/date.ts', startLine: 10, endLine: 80 }),
    ).toBe('⚙ Read src/utils/date.ts:10–80');
  });

  test('searchCode quotes the query', () => {
    expect(describeToolCall('searchCode', { query: 'formatMetric' })).toBe(
      '⚙ Searched "formatMetric"',
    );
  });

  test('gitContext names the side or commit', () => {
    expect(describeToolCall('gitContext', {})).toBe('⚙ Git: branch history');
    expect(describeToolCall('gitContext', { side: 'theirs' })).toBe('⚙ Git: theirs history');
    expect(describeToolCall('gitContext', { commit: 'abc1234def' })).toBe('⚙ Git: commit abc1234');
  });

  test('findSymbol names the symbol', () => {
    expect(describeToolCall('findSymbol', { name: 'CreateMetricModal' })).toBe(
      '⚙ Looked up CreateMetricModal',
    );
  });

  test('unknown tools and malformed input degrade to the bare name', () => {
    expect(describeToolCall('mystery', { anything: 1 })).toBe('⚙ mystery');
    expect(describeToolCall('readFile', null)).toBe('⚙ readFile');
  });
});

describe('runTool', () => {
  test('dispatches to the matching executor and returns its text', async () => {
    const out = await runTool(executors(), 'searchCode', { query: 'greet' });
    expect(out).toBe('hits for greet');
  });

  test('an executor throw becomes an error string, never a rejection', async () => {
    const out = await runTool(
      executors({
        readFile: async () => {
          throw new Error('outside the workspace');
        },
      }),
      'readFile',
      { path: '../etc/passwd' },
    );
    expect(out).toContain('Tool error');
    expect(out).toContain('outside the workspace');
  });

  test('an unknown tool name reports itself instead of throwing', async () => {
    const out = await runTool(executors(), 'launchMissiles', {});
    expect(out).toContain('Unknown tool');
  });

  test('non-object input still reaches the executor as an empty object', async () => {
    const out = await runTool(executors(), 'gitContext', undefined);
    expect(out).toBe('history of both');
  });
});
