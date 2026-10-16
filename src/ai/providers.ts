/**
 * The AI provider registry: which backends the explain feature can call with a user
 * API key, and each one's endpoint and default model. Pure data + helpers, no vscode
 * import, so the registry is unit-testable.
 *
 * Every provider except Anthropic speaks the OpenAI chat-completions protocol and is
 * driven through `@ai-sdk/openai-compatible` with the base URL below; Anthropic goes
 * through `@ai-sdk/anthropic` (native protocol, endpoint built in).
 *
 * Default model IDs pinned 2026-07-17 against the providers' docs:
 * - DeepSeek: `deepseek-chat`/`deepseek-reasoner` aliases retire 2026-07-24; the
 *   current IDs are deepseek-v4-flash / deepseek-v4-pro.
 * - Kimi (Moonshot): kimi-k2.6 is the documented example model (kimi-k3 also exists);
 *   international endpoint api.moonshot.ai.
 * - OpenAI: gpt-5.6-sol is the flagship (terra = balanced, luna = budget).
 */

export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'kimi' | 'custom';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible endpoint; undefined for anthropic (own SDK) and custom (setting). */
  baseUrl?: string;
  /** Undefined for custom — the model comes from `mergeForge.ai.customModel`. */
  defaultModel?: string;
  /** Hint shown in the key input box. */
  keyPlaceholder: string;
  /** True when the endpoint may not need a key at all (e.g. local Ollama). */
  keyOptional?: boolean;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-opus-4-8',
    keyPlaceholder: 'sk-ant-…',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-sol',
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6',
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    keyPlaceholder: 'key, or leave empty for local endpoints',
    keyOptional: true,
  },
];

export function providerById(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((spec) => spec.id === id);
}

/**
 * Resolves the model to request: `'auto'` (or empty) means the provider's default —
 * for custom, the user's `customModel` setting — anything else is an explicit override.
 */
export function resolveModel(setting: string, spec: ProviderSpec, customModel?: string): string {
  const trimmed = setting.trim();
  if (trimmed !== '' && trimmed !== 'auto') {
    return trimmed;
  }
  return spec.defaultModel ?? customModel?.trim() ?? '';
}
