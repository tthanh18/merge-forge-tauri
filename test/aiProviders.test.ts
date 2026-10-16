import { describe, expect, test } from 'vitest';
import { PROVIDERS, providerById, resolveModel } from '../src/ai/providers';

describe('provider registry', () => {
  test('contains the five providers in quick-pick order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'anthropic',
      'openai',
      'deepseek',
      'kimi',
      'custom',
    ]);
  });

  test('every hosted provider has a base URL and default model; custom has neither', () => {
    for (const spec of PROVIDERS) {
      if (spec.id === 'custom') {
        expect(spec.baseUrl).toBeUndefined();
        expect(spec.defaultModel).toBeUndefined();
        expect(spec.keyOptional).toBe(true);
      } else if (spec.id === 'anthropic') {
        // Anthropic goes through @ai-sdk/anthropic, which knows its own endpoint.
        expect(spec.baseUrl).toBeUndefined();
        expect(spec.defaultModel).toBeTruthy();
      } else {
        expect(spec.baseUrl).toMatch(/^https:\/\//);
        expect(spec.defaultModel).toBeTruthy();
      }
    }
  });

  test('providerById resolves known ids and rejects unknown ones', () => {
    expect(providerById('deepseek')?.label).toBe('DeepSeek');
    expect(providerById('nope')).toBeUndefined();
  });
});

describe('resolveModel', () => {
  const deepseek = providerById('deepseek')!;
  const custom = providerById('custom')!;

  test("'auto' falls back to the provider default", () => {
    expect(resolveModel('auto', deepseek)).toBe(deepseek.defaultModel);
  });

  test('an explicit setting overrides the default', () => {
    expect(resolveModel('deepseek-v4-pro', deepseek)).toBe('deepseek-v4-pro');
  });

  test('custom uses the customModel argument when the setting is auto', () => {
    expect(resolveModel('auto', custom, 'llama3.3')).toBe('llama3.3');
  });

  test('custom with no model anywhere resolves to empty string', () => {
    expect(resolveModel('auto', custom)).toBe('');
  });
});
