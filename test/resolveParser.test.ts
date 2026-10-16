import { describe, expect, test } from 'vitest';
import { parseResolutions } from '../src/ai/resolveParser';

describe('parseResolutions', () => {
  test('extracts every well-formed block', () => {
    const text = [
      '<<<RESOLVED 1>>>',
      'const a = 1;',
      '<<<END 1>>>',
      '<<<RESOLVED 2>>>',
      'const b = 2;',
      'const c = 3;',
      '<<<END 2>>>',
    ].join('\n');
    const map = parseResolutions(text, [1, 2]);
    expect(map.get(1)).toBe('const a = 1;\n');
    expect(map.get(2)).toBe('const b = 2;\nconst c = 3;\n');
  });

  test('a missing block is simply absent — the rest still parse', () => {
    const text = '<<<RESOLVED 2>>>\nkept\n<<<END 2>>>';
    const map = parseResolutions(text, [1, 2]);
    expect(map.has(1)).toBe(false);
    expect(map.get(2)).toBe('kept\n');
  });

  test('commentary around the blocks is ignored', () => {
    const text = [
      'Sure! Here are the resolutions:',
      '<<<RESOLVED 1>>>',
      'merged();',
      '<<<END 1>>>',
      'Hope that helps.',
    ].join('\n');
    expect(parseResolutions(text, [1]).get(1)).toBe('merged();\n');
  });

  test('an empty resolution (delete both sides) stays empty', () => {
    const text = '<<<RESOLVED 1>>>\n<<<END 1>>>';
    expect(parseResolutions(text, [1]).get(1)).toBe('');
  });

  test('mismatched END index does not close the block', () => {
    const text = '<<<RESOLVED 1>>>\ncode\n<<<END 2>>>';
    expect(parseResolutions(text, [1, 2]).size).toBe(0);
  });

  test('indexes not in the expected list are dropped', () => {
    const text = '<<<RESOLVED 7>>>\nsurprise\n<<<END 7>>>';
    expect(parseResolutions(text, [1]).size).toBe(0);
  });

  test('a fenced code wrapper inside the block is stripped', () => {
    // Models sometimes wrap the code in markdown fences despite instructions.
    const text = '<<<RESOLVED 1>>>\n```ts\nconst a = 1;\n```\n<<<END 1>>>';
    expect(parseResolutions(text, [1]).get(1)).toBe('const a = 1;\n');
  });
});
