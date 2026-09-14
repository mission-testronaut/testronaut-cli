// tests/tokenControlTests/tokenControl.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoist env so we can safely mutate per test
const ORIGINAL_ENV = { ...process.env };

// Mock wait so tests are instant
vi.mock('../../tools/turnLoopUtils.js', () => ({
  wait: vi.fn(async () => {}),
}));

// Mock tiktoken in a controllable way
const encMock = {
  encode: vi.fn((s) => Array.from(String(s)).map(() => 1)), // 1 token per char
  free: vi.fn(() => {}),
};

const tiktokenMocks = vi.hoisted(() => ({
  encoding_for_model_impl: vi.fn(),
  get_encoding_impl: vi.fn(() => encMock),
}));

vi.mock('@dqbd/tiktoken', () => ({
  encoding_for_model: (model) => tiktokenMocks.encoding_for_model_impl(model),
  get_encoding: (name) => tiktokenMocks.get_encoding_impl(name),
}));

// Import after mocks
import {
  tokenEstimate,
  getCurrentTokenLimit,
  updateLimitsFromHeaders,
  updateLimitsFromError,
  configureTokenControl,
  tokenUseCoolOff,
  recordTokenUsage,
  pruneOldTokenUsage,
  warnIfContextNearLimit,
  __resetTokenControlForTests,
} from '../../tools/tokenControl.js';
import { wait } from '../../tools/turnLoopUtils.js';

describe('tokenControl', () => {
  beforeEach(() => {
    // reset env and mocks
    process.env = { ...ORIGINAL_ENV };
    __resetTokenControlForTests(); 
    tiktokenMocks.encoding_for_model_impl.mockReset();
    tiktokenMocks.get_encoding_impl.mockReset().mockReturnValue(encMock);
    encMock.encode.mockClear();
    encMock.free.mockClear();
    wait.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('tokenEstimate', () => {
    it('uses encoding_for_model when available', async () => {
      tiktokenMocks.encoding_for_model_impl.mockReturnValue(encMock);

      const n = await tokenEstimate('gpt-4o', 'abcd'); // 4 chars → 4 tokens via mock
      expect(n).toBe(4);
      expect(encMock.encode).toHaveBeenCalledOnce();
      expect(encMock.free).toHaveBeenCalledOnce();
    });

    it('falls back to get_encoding when encoding_for_model throws', async () => {
      tiktokenMocks.encoding_for_model_impl.mockImplementation(() => { throw new Error('no direct encoding'); });
      tiktokenMocks.get_encoding_impl.mockReturnValue(encMock);

      const n = await tokenEstimate('gemini-2.5-flash', 'abc'); // 3
      expect(n).toBe(3);
      expect(encMock.encode).toHaveBeenCalledOnce();
    });

    it('falls back to bytes/4 when both tokenizers fail', async () => {
      tiktokenMocks.encoding_for_model_impl.mockImplementation(() => { throw new Error('no direct encoding'); });
      tiktokenMocks.get_encoding_impl.mockImplementation(() => { throw new Error('no base encoding'); });

      const n = await tokenEstimate('unknown-model', 'abcdefgh'); // 8 bytes → 8/4 = 2
      expect(n).toBe(2);
    });

    it('stringifies non-string input', async () => {
      tiktokenMocks.encoding_for_model_impl.mockReturnValue(encMock);
      const n = await tokenEstimate('gpt-4o', { a: 1, b: 2 });
      expect(encMock.encode).toHaveBeenCalled();
      expect(typeof n).toBe('number');
    });
  });

  describe('getCurrentTokenLimit / updateLimitsFromHeaders', () => {
    it('uses defaults by model pattern', () => {
      const openai = getCurrentTokenLimit('gpt-4o');
      const gemini = getCurrentTokenLimit('gemini-2.5-flash');
      expect(openai.tpm).toBeGreaterThan(0);
      expect(gemini.tpm).toBeGreaterThan(0);
      expect(['default', 'env', 'header']).toContain(openai.source);
    });

    it('honors ENV override TESTRONAUT_TOKENS_PER_MIN', () => {
      process.env.TESTRONAUT_TOKENS_PER_MIN = '999';
      const anyModel = getCurrentTokenLimit('what-ever-model');
      expect(anyModel.tpm).toBe(999);
      expect(anyModel.source).toBe('env');
    });

    it('warns once when a numeric environment override is configured', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.TESTRONAUT_TOKENS_PER_MIN = '999';
      configureTokenControl({ provider: 'openai' });
      configureTokenControl({ provider: 'openai' });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain('TPM override active');
      expect(warn.mock.calls[0][0]).toContain('unset TESTRONAUT_TOKENS_PER_MIN');
      expect(warn.mock.calls[0][0]).toContain('TESTRONAUT_TOKENS_PER_MIN=auto');
      warn.mockRestore();
    });

    it('treats auto as a one-run bypass for an inherited override', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.TESTRONAUT_TOKENS_PER_MIN = 'auto';
      configureTokenControl({
        provider: 'openai',
        rateLimits: { models: { 'gpt-4o': { fallbackTPM: 777 } } },
      });
      expect(getCurrentTokenLimit('gpt-4o')).toEqual({ tpm: 777, source: 'config-fallback' });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('gives the environment override priority over config and learned headers', () => {
      configureTokenControl({
        provider: 'openai',
        rateLimits: { models: { 'gpt-4o': { tpm: 700 } } },
      });
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': '800' });
      process.env.TESTRONAUT_TOKENS_PER_MIN = '900';
      expect(getCurrentTokenLimit('gpt-4o')).toEqual({ tpm: 900, source: 'env' });
    });

    it('gives an explicit model config override priority over learned headers', () => {
      configureTokenControl({
        provider: 'openai',
        rateLimits: { models: { 'gpt-4o': { tpm: 700, fallbackTPM: 600 } } },
      });
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': '800' });
      expect(getCurrentTokenLimit('gpt-4o')).toEqual({ tpm: 700, source: 'config' });
    });

    it('ignores invalid environment and config values', () => {
      process.env.TESTRONAUT_TOKENS_PER_MIN = '-4';
      configureTokenControl({
        provider: 'openai',
        rateLimits: { models: { 'future-model': { tpm: 'nope', fallbackTPM: 0 } } },
      });
      expect(getCurrentTokenLimit('future-model')).toEqual({ tpm: 150000, source: 'default' });
    });

    it('updates limits from headers (header wins)', () => {
      const before = getCurrentTokenLimit('gpt-4o');
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': '1234' });
      const after = getCurrentTokenLimit('gpt-4o');
      expect(after.tpm).toBe(1234);
      expect(after.source).toBe('header');
      // sanity check it actually changed (unless defaults already 1234)
      if (before.tpm !== 1234) expect(after.tpm).not.toBe(before.tpm);
    });

    it('uses selected-model config fallback but lets learned headers supersede it', () => {
      configureTokenControl({
        provider: 'openai',
        rateLimits: { safetyMargin: 0.9, models: { 'gpt-4o': { fallbackTPM: 777 } } },
      });
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({ tpm: 777, source: 'config-fallback' });
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': '888' });
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({ tpm: 888, source: 'header' });
    });

    it('reads Headers objects and captures remaining/reset/request metadata', () => {
      const headers = new Headers({
        'x-ratelimit-limit-tokens': '1234',
        'x-ratelimit-remaining-tokens': '1000',
        'x-ratelimit-reset-tokens': '2s',
        'x-ratelimit-limit-requests': '50',
      });
      updateLimitsFromHeaders('gpt-4o', headers);
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({
        tpm: 1234,
        remainingTokens: 1000,
        resetTokens: '2s',
        rpm: 50,
      });
    });

    it('accepts alternate token-limit header names case-insensitively', () => {
      updateLimitsFromHeaders('gpt-4o', { 'X-RateLimit-Limit-TPM': '4321' });
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({ tpm: 4321, source: 'header' });
    });

    it('ignores missing models and invalid learned limits', () => {
      updateLimitsFromHeaders('', { 'x-ratelimit-limit-tokens': '999' });
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': 'not-a-number' });
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({ tpm: 450000, source: 'default' });
    });

    it('learns retry timing from a structured rate-limit error message', () => {
      expect(updateLimitsFromError('gemini-2.5-pro', {
        message: 'Quota exhausted. Please retry in 11.5s',
      })).toEqual({ retryAfterMs: 11500 });
    });

    it('prefers Retry-After from a Headers object', () => {
      expect(updateLimitsFromError('gpt-4o', {
        headers: new Headers({
          'retry-after': '3.25',
          'x-ratelimit-limit-tokens': '5000',
        }),
        message: 'retry in 20s',
      })).toEqual({ retryAfterMs: 3250 });
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({ tpm: 5000, source: 'header' });
    });

    it('returns no retry duration when an error provides none', () => {
      expect(updateLimitsFromError('gpt-4o', { message: 'rate limited' }))
        .toEqual({ retryAfterMs: undefined });
    });

    it('clears learned state when runtime context is reconfigured', () => {
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': '1234' });
      configureTokenControl({ provider: 'openai' });
      expect(getCurrentTokenLimit('gpt-4o')).toMatchObject({ tpm: 450000, source: 'default' });
    });

    it('uses tier-1 defaults without letting generic GPT-5 rules shadow variants', () => {
      expect(getCurrentTokenLimit('gpt-5.6').tpm).toBe(500000);
      expect(getCurrentTokenLimit('gpt-5.6-luna').tpm).toBe(500000);
      expect(getCurrentTokenLimit('gpt-5.4-nano').tpm).toBe(200000);
      expect(getCurrentTokenLimit('gpt-5-mini').tpm).toBe(240000);
      expect(getCurrentTokenLimit('gpt-5-nano').tpm).toBe(600000);
    });
  });

  it('warns without truncating when known context usage crosses the threshold', async () => {
    tiktokenMocks.encoding_for_model_impl.mockReturnValue(encMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await warnIfContextNearLimit('gpt-5.2', '1234567890', 0.00002);
    expect(result.warned).toBe(true);
    expect(result.contextWindow).toBe(400000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('rolling window + cooldown', () => {
    it('prunes old entries outside the window', () => {
      const now = Date.now();
      const entries = [
        [now - 70000, 100], // old → pruned
        [now - 10000, 50],  // kept
        [now - 5000, 30],   // kept
      ];
      const { turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(entries, 60000);
      expect(turnTimestamps.length).toBe(2);
      expect(totalTokensUsed).toBe(80);
    });

    it('triggers backoff when usage exceeds TPM', async () => {
      // small ENV cap to force backoff
      process.env.TESTRONAUT_TOKENS_PER_MIN = '50';
      const entries = [];
      recordTokenUsage(entries, 60);

      const result = await tokenUseCoolOff(60, entries, 'any-model');
      expect(result.shouldBackoff).toBe(true);
      expect(result.totalTokensUsed).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.turnTimestamps)).toBe(true);
    });

    it('does not backoff when under TPM', async () => {
      process.env.TESTRONAUT_TOKENS_PER_MIN = '100';
      const entries = [];
      recordTokenUsage(entries, 60);
      const result = await tokenUseCoolOff(60, entries, 'any-model');
      expect(result.shouldBackoff).toBe(false);
      expect(result.totalTokensUsed).toBe(60);
    });

    it('reserves the projected next request against the safety margin', async () => {
      process.env.TESTRONAUT_TOKENS_PER_MIN = '100';
      const entries = [];
      recordTokenUsage(entries, 80);
      const result = await tokenUseCoolOff(80, entries, 'any-model', 15);
      expect(result.shouldBackoff).toBe(true);
    });

    it('honors a configured safety margin', async () => {
      configureTokenControl({
        provider: 'openai',
        rateLimits: {
          safetyMargin: 0.5,
          models: { 'gpt-4o': { tpm: 100 } },
        },
      });
      const entries = [];
      recordTokenUsage(entries, 45);
      expect((await tokenUseCoolOff(45, entries, 'gpt-4o', 6)).shouldBackoff).toBe(true);
    });

    it('does not wait forever when one projected request alone exceeds the limit', async () => {
      process.env.TESTRONAUT_TOKENS_PER_MIN = '10';
      const result = await tokenUseCoolOff(0, [], 'any-model', 100);
      expect(result.shouldBackoff).toBe(false);
      expect(wait).not.toHaveBeenCalled();
    });

    it('waits until the oldest necessary rolling entry expires', async () => {
      process.env.TESTRONAUT_TOKENS_PER_MIN = '100';
      const now = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const entries = [[now - 50000, 40], [now - 10000, 40]];
      await tokenUseCoolOff(80, entries, 'any-model', 15);
      expect(wait).toHaveBeenCalledWith(10000);
      nowSpy.mockRestore();
    });
  });
});
