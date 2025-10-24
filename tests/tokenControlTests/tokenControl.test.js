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
  tokenUseCoolOff,
  recordTokenUsage,
  pruneOldTokenUsage,
  __resetTokenControlForTests,
} from '../../tools/tokenControl.js';

describe('tokenControl', () => {
  beforeEach(() => {
    // reset env and mocks
    process.env = { ...ORIGINAL_ENV };
    __resetTokenControlForTests(); 
    tiktokenMocks.encoding_for_model_impl.mockReset();
    tiktokenMocks.get_encoding_impl.mockReset().mockReturnValue(encMock);
    encMock.encode.mockClear();
    encMock.free.mockClear();
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

    it('updates limits from headers (header wins)', () => {
      const before = getCurrentTokenLimit('gpt-4o');
      updateLimitsFromHeaders('gpt-4o', { 'x-ratelimit-limit-tokens': '1234' });
      const after = getCurrentTokenLimit('gpt-4o');
      expect(after.tpm).toBe(1234);
      expect(after.source).toBe('header');
      // sanity check it actually changed (unless defaults already 1234)
      if (before.tpm !== 1234) expect(after.tpm).not.toBe(before.tpm);
    });
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
      expect(result.totalTokensUsed).toBe(0);
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
  });
});
