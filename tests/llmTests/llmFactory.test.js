// tests/llmTests/llmFactory.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted shared spies so mock factories can access them
const { shared } = vi.hoisted(() => ({
  shared: {
    openAICtor: vi.fn(),
    geminiCtor: vi.fn(),
  },
}));

// Mock provider classes; constructors record received options
vi.mock('../../llm/openAI/openaiProvider.js', () => ({
  OpenAIProvider: function (opts) {
    shared.openAICtor(opts);
    // minimal adapter surface used by callers
    this.chat = vi.fn(async () => ({ message: { role: 'assistant', content: 'ok' }, usage: {} }));
  },
}));

vi.mock('../../llm/gemini/geminiProvider.js', () => ({
  GeminiProvider: function (opts) {
    shared.geminiCtor(opts);
    this.chat = vi.fn(async () => ({ message: { role: 'assistant', content: 'ok' }, usage: {} }));
  },
}));

// Import SUT after mocks
import { getLLM } from '../../llm/llmFactory.js';

const ORIGINAL_ENV = { ...process.env };

describe('getLLM', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    shared.openAICtor.mockClear();
    shared.geminiCtor.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('creates OpenAI provider (case-insensitive) and passes env key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-123';
    const llm = getLLM('OpEnAi');
    expect(typeof llm.chat).toBe('function');
    expect(shared.openAICtor).toHaveBeenCalledTimes(1);
    expect(shared.openAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-openai-123' })
    );
    expect(shared.geminiCtor).not.toHaveBeenCalled();
  });

  it('creates Gemini provider and passes env key', () => {
    process.env.GEMINI_API_KEY = 'gk-gemini-abc';
    const llm = getLLM('gemini');
    expect(typeof llm.chat).toBe('function');
    expect(shared.geminiCtor).toHaveBeenCalledTimes(1);
    expect(shared.geminiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'gk-gemini-abc' })
    );
    expect(shared.openAICtor).not.toHaveBeenCalled();
  });

  it('merges opts after env so explicit opts.apiKey overrides env', () => {
    process.env.OPENAI_API_KEY = 'sk-env-will-be-overridden';
    const llm = getLLM('openai', { apiKey: 'sk-passed-in' });
    expect(shared.openAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-passed-in' })
    );
    expect(typeof llm.chat).toBe('function');
  });

  it('throws on unsupported provider', () => {
    expect(() => getLLM('anthropic')).toThrow(/Unsupported LLM provider/i);
  });
});
