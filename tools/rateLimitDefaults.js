const MODEL_LIMITS = [
  { provider: 'openai', test: /^gpt-5\.6(-|$)/i, tpm: 500000 },
  { provider: 'openai', test: /^gpt-5\.5(-|$)/i, tpm: 500000 },
  { provider: 'openai', test: /^gpt-5\.4-nano(-|$)/i, tpm: 200000 },
  { provider: 'openai', test: /^gpt-5\.4(-|$)/i, tpm: 500000 },
  { provider: 'openai', test: /^gpt-5\.2(-|$)/i, tpm: 500000 },
  { provider: 'openai', test: /^gpt-5\.1(-|$)/i, tpm: 120000 },
  { provider: 'openai', test: /^gpt-5-mini(-|$)/i, tpm: 240000 },
  { provider: 'openai', test: /^gpt-5-nano(-|$)/i, tpm: 600000 },
  { provider: 'openai', test: /^gpt-5(-|$)/i, tpm: 90000 },
  { provider: 'openai', test: /^gpt-4o(-|$)/i, tpm: 450000 },
  { provider: 'openai', test: /^gpt-4\.1(-|$)/i, tpm: 1000000 },
  { provider: 'openai', test: /^o3(-|$)/i, tpm: 300000 },
  { provider: 'openai', test: /^o4-mini(-|$)/i, tpm: 600000 },
  { provider: 'openai', test: /^gpt-4(-|$)/i, tpm: 150000 },
  { provider: 'openai', test: /^gpt-3\.5(-|$)/i, tpm: 600000 },
  { provider: 'gemini', test: /^gemini-2\.5-pro(-|$)/i, tpm: 120000 },
  { provider: 'gemini', test: /^gemini-2\.5-flash(-|$)/i, tpm: 300000 },
  { provider: 'anthropic', test: /^claude-(opus|sonnet)-/i, tpm: 80000 },
  { provider: 'anthropic', test: /^claude-haiku-/i, tpm: 100000 },
];

export function getFallbackTPM(provider, model) {
  const normalizedProvider = provider === 'claude' ? 'anthropic' : provider;
  const hit = MODEL_LIMITS.find(entry =>
    (!normalizedProvider || entry.provider === normalizedProvider) && entry.test.test(model || '')
  );
  return hit?.tpm ?? 150000;
}

export function defaultRateLimitConfig(provider, model) {
  return {
    tier: 'unknown',
    region: 'global',
    safetyMargin: 0.9,
    models: {
      [model]: { fallbackTPM: getFallbackTPM(provider, model) },
    },
  };
}
