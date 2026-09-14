import { describe, expect, it } from 'vitest';
import { defaultRateLimitConfig, getFallbackTPM } from '../../tools/rateLimitDefaults.js';

describe('rateLimitDefaults', () => {
  it.each([
    ['openai', 'gpt-5.6', 500000],
    ['openai', 'gpt-5.6-luna', 500000],
    ['openai', 'gpt-5.4-nano', 200000],
    ['openai', 'gpt-5-mini', 240000],
    ['gemini', 'gemini-2.5-pro', 120000],
    ['gemini', 'gemini-2.5-flash', 300000],
    ['anthropic', 'claude-sonnet-5', 80000],
    ['claude', 'claude-haiku-4-5', 100000],
  ])('resolves %s/%s to %i TPM', (provider, model, expected) => {
    expect(getFallbackTPM(provider, model)).toBe(expected);
  });

  it('does not match a model family belonging to a different provider', () => {
    expect(getFallbackTPM('gemini', 'gpt-4o')).toBe(150000);
  });

  it('uses a conservative fallback for unknown models', () => {
    expect(getFallbackTPM('custom', 'future-model')).toBe(150000);
  });

  it('generates config for only the selected model', () => {
    expect(defaultRateLimitConfig('openai', 'gpt-4o')).toEqual({
      tier: 'unknown',
      region: 'global',
      safetyMargin: 0.9,
      models: { 'gpt-4o': { fallbackTPM: 450000 } },
    });
  });
});
