import { describe, expect, test } from 'vitest';
import {
  buildChatPrompt,
  buildExplainPrompt,
  buildResolvePrompt,
  buildRetryAddendum,
  FILE_CONTEXT_CAP,
  CONTEXT_WINDOW_LINES,
  SIDE_TEXT_CAP,
} from '../src/ai/prompt';
import type { ExplainConflict, ExplainRequest } from '../src/protocol';

function conflict(overrides: Partial<ExplainConflict> = {}): ExplainConflict {
  return {
    index: 1,
    chunkId: 0,
    baseText: 'const a = 1;\n',
    leftText: 'const a = 2;\n',
    rightText: 'const a = 3;\n',
    resultStart: 0,
    resultEnd: 1,
    ...overrides,
  };
}

function request(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    filePath: 'src/components/CreateMetricModal.vue',
    languageId: 'vue',
    labels: { left: 'feature/metrics', right: 'main' },
    resultText: 'const a = 2;\n',
    conflicts: [conflict()],
    ...overrides,
  };
}

describe('buildExplainPrompt', () => {
  test('user prompt names the file, language, and both branches', () => {
    const { user } = buildExplainPrompt(request());
    expect(user).toContain('src/components/CreateMetricModal.vue');
    expect(user).toContain('vue');
    expect(user).toContain('feature/metrics');
    expect(user).toContain('main');
  });

  test('one section per conflict with base and both sides fenced', () => {
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          conflict({
            index: 1,
            chunkId: 1,
            baseText: 'one\n',
            leftText: 'uno\n',
            rightText: 'eins\n',
          }),
          conflict({
            index: 2,
            chunkId: 2,
            baseText: 'two\n',
            leftText: 'dos\n',
            rightText: 'zwei\n',
          }),
        ],
      }),
    );
    expect(user).toContain('## Conflict 1');
    expect(user).toContain('## Conflict 2');
    expect(user).toContain('uno');
    expect(user).toContain('eins');
    expect(user).toContain('two');
    // Every conflict carries three fenced blocks (base, yours, theirs),
    // plus one fence for the whole-file context baseline.
    expect(user.match(/```/g)?.length).toBe(2 * 3 * 2 + 2);
  });

  test('system prompt asks for per-conflict explanation and a suggested resolution', () => {
    const { system } = buildExplainPrompt(request());
    expect(system.toLowerCase()).toContain('resolution');
    expect(system).toContain('### Conflict');
    // The every-conflict contract lives in the system prompt…
    expect(system).toContain('every conflict');
  });

  test('user prompt closes with the exact expected section count', () => {
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          conflict({
            index: 1,
            chunkId: 1,
            baseText: 'one\n',
            leftText: 'uno\n',
            rightText: 'eins\n',
          }),
          conflict({
            index: 2,
            chunkId: 2,
            baseText: 'two\n',
            leftText: 'dos\n',
            rightText: 'zwei\n',
          }),
          conflict({
            index: 3,
            chunkId: 3,
            baseText: 'three\n',
            leftText: 'tres\n',
            rightText: 'drei\n',
          }),
        ],
      }),
    );
    // …and the per-request count contract in the user prompt, so a model can't
    // quietly stop after the first section.
    expect(user).toContain('exactly 3 "### Conflict" sections');
  });

  test('long sides are truncated at the cap with a marker', () => {
    const long = 'x'.repeat(SIDE_TEXT_CAP + 500);
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          conflict({ index: 1, chunkId: 1, baseText: '', leftText: long, rightText: 'ok\n' }),
        ],
      }),
    );
    expect(user).toContain('…truncated…');
    expect(user).not.toContain('x'.repeat(SIDE_TEXT_CAP + 1));
  });

  test('an empty side is rendered as deleted, not as an empty block', () => {
    const { user } = buildExplainPrompt(
      request({
        conflicts: [
          conflict({ index: 1, chunkId: 1, baseText: 'gone\n', leftText: '', rightText: 'kept\n' }),
        ],
      }),
    );
    expect(user).toContain('(no lines — deleted)');
  });
});

describe('buildResolvePrompt', () => {
  test('system prompt demands the delimiter protocol and nothing else', () => {
    const { system } = buildResolvePrompt(request());
    expect(system).toContain('<<<RESOLVED');
    expect(system).toContain('<<<END');
    expect(system.toLowerCase()).toContain('only');
  });

  test('user prompt carries the conflicts and the expected block count', () => {
    const { user } = buildResolvePrompt(
      request({
        conflicts: [
          conflict({
            index: 1,
            chunkId: 1,
            baseText: 'one\n',
            leftText: 'uno\n',
            rightText: 'eins\n',
          }),
          conflict({
            index: 2,
            chunkId: 2,
            baseText: 'two\n',
            leftText: 'dos\n',
            rightText: 'zwei\n',
          }),
        ],
      }),
    );
    expect(user).toContain('## Conflict 1');
    expect(user).toContain('## Conflict 2');
    expect(user).toContain('exactly 2');
    expect(user).toContain('<<<RESOLVED 1>>>');
  });

  test('a prior explanation is included as context when provided', () => {
    const { user } = buildResolvePrompt(request(), '### Conflict 1\nTake theirs.');
    expect(user).toContain('Earlier analysis');
    expect(user).toContain('Take theirs.');
  });

  test('without an explanation there is no analysis section', () => {
    const { user } = buildResolvePrompt(request());
    expect(user).not.toContain('Earlier analysis');
  });
});

describe('buildChatPrompt', () => {
  test('carries the conflicts, prior turns in order, and the new question last', () => {
    const { user } = buildChatPrompt(
      request(),
      [
        { question: 'Why do these collide?', answer: 'Both edited the greeting.' },
        { question: 'Which side is newer?', answer: 'Theirs, by commit date.' },
      ],
      'So which should I take?',
    );
    expect(user).toContain('## Conflict 1');
    const q1 = user.indexOf('Why do these collide?');
    const a1 = user.indexOf('Both edited the greeting.');
    const q2 = user.indexOf('Which side is newer?');
    const final = user.indexOf('So which should I take?');
    expect(q1).toBeGreaterThan(-1);
    expect(a1).toBeGreaterThan(q1);
    expect(q2).toBeGreaterThan(a1);
    expect(final).toBeGreaterThan(q2);
  });

  test('works with no history', () => {
    const { user, system } = buildChatPrompt(request(), [], 'What changed here?');
    expect(user).toContain('What changed here?');
    expect(system.toLowerCase()).toContain('question');
  });
});

describe('file context (rich baseline)', () => {
  test('a small result document is included whole', () => {
    const doc = 'line one\nline two\nconst a = 2;\nline four\n';
    const { user } = buildExplainPrompt(
      request({ resultText: doc, conflicts: [conflict({ resultStart: 2, resultEnd: 3 })] }),
    );
    expect(user).toContain('Current merge result');
    expect(user).toContain('line one');
    expect(user).toContain('line four');
  });

  test('a large document falls back to windows around each conflict', () => {
    // 3000 numbered lines ≈ 3000 * 12 chars > FILE_CONTEXT_CAP.
    const lines = Array.from({ length: 3000 }, (_, i) => `line number ${i}`);
    const doc = lines.join('\n');
    expect(doc.length).toBeGreaterThan(FILE_CONTEXT_CAP);
    const { user } = buildExplainPrompt(
      request({
        resultText: doc,
        conflicts: [conflict({ resultStart: 1000, resultEnd: 1002 })],
      }),
    );
    // The window spans ±CONTEXT_WINDOW_LINES around the conflict…
    expect(user).toContain(`line number ${1000 - CONTEXT_WINDOW_LINES}`);
    expect(user).toContain(`line number ${1001 + CONTEXT_WINDOW_LINES}`);
    // …and far-away lines are not shipped.
    expect(user).not.toContain('line number 1\n');
    expect(user).not.toContain('line number 2999');
    // Windows are labeled with 1-based line numbers.
    expect(user).toContain(`Lines ${1000 - CONTEXT_WINDOW_LINES + 1}–`);
  });

  test('overlapping windows are merged into one excerpt', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line number ${i}`);
    const doc = lines.join('\n');
    const { user } = buildExplainPrompt(
      request({
        resultText: doc,
        conflicts: [
          conflict({ index: 1, chunkId: 1, resultStart: 100, resultEnd: 102 }),
          conflict({ index: 2, chunkId: 2, resultStart: 120, resultEnd: 122 }),
        ],
      }),
    );
    // One merged excerpt, not two: exactly one "Lines …" header for the pair.
    expect(user.match(/Lines \d+–\d+/g)?.length).toBe(1);
  });

  test('an empty result text produces no file-context section', () => {
    const { user } = buildExplainPrompt(request({ resultText: '' }));
    expect(user).not.toContain('Current merge result');
  });
});

describe('branch intent (commit subjects)', () => {
  test('subjects for both sides are listed under the branch labels', () => {
    const { user } = buildExplainPrompt(request(), {
      subjects: {
        yours: ['fix: metric rounding', 'feat: add unit selector'],
        theirs: ['refactor: rename props'],
      },
    });
    expect(user).toContain('fix: metric rounding');
    expect(user).toContain('refactor: rename props');
    const intent = user.indexOf('Branch intent');
    expect(intent).toBeGreaterThan(-1);
    // Intent precedes the conflict sections so the model reads it first.
    expect(intent).toBeLessThan(user.indexOf('## Conflict 1'));
  });

  test('no subjects → no intent section', () => {
    const { user } = buildExplainPrompt(request(), { subjects: { yours: [], theirs: [] } });
    expect(user).not.toContain('Branch intent');
  });
});

describe('tools guidance', () => {
  test('when tools are available every builder advertises them in the system prompt', () => {
    const context = { toolsAvailable: true };
    for (const { system } of [
      buildExplainPrompt(request(), context),
      buildResolvePrompt(request(), undefined, context),
      buildChatPrompt(request(), [], 'q', context),
    ]) {
      expect(system).toContain('readFile');
      expect(system).toContain('searchCode');
      expect(system).toContain('gitContext');
      expect(system).toContain('findSymbol');
      expect(system.toLowerCase()).toContain('do not guess');
    }
  });

  test('without tools the system prompts stay tool-free', () => {
    const { system } = buildExplainPrompt(request());
    expect(system).not.toContain('readFile');
  });
});

describe('buildRetryAddendum', () => {
  test('names the missing conflict indexes and restates the block contract', () => {
    const addendum = buildRetryAddendum([2, 4]);
    expect(addendum).toContain('2');
    expect(addendum).toContain('4');
    expect(addendum).toContain('<<<RESOLVED');
  });
});
