// tests/llmTests/openAIProvider.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted shared so the mock factory can access/record state
const { shared } = vi.hoisted(() => ({
  shared: {
    ctorOpts: null,
    lastCreateArgs: null,
    // default response; tests can override
    responseFactory: () => ({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { total_tokens: 321, prompt_tokens: 100, completion_tokens: 221 },
      headers: { 'x-ratelimit-limit-tokens': '90000' },
    }),
  },
}));

// Mock the OpenAI SDK surface we use
vi.mock('openai', () => {
  class FakeChatCompletions {
    async create(args) {
      shared.lastCreateArgs = args;
      return shared.responseFactory();
    }
  }
  class FakeChat {
    constructor() {
      this.completions = new FakeChatCompletions();
    }
  }
  class OpenAI {
    constructor(opts) {
      shared.ctorOpts = opts;
      this.chat = new FakeChat();
    }
  }
  return { default: OpenAI };
});

// Import SUT after mocks
import { OpenAIProvider } from '../../llm/openAI/openaiProvider.js';

describe('OpenAIProvider', () => {
  beforeEach(() => {
    shared.ctorOpts = null;
    shared.lastCreateArgs = null;
    shared.responseFactory = () => ({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { total_tokens: 321, prompt_tokens: 100, completion_tokens: 221 },
      headers: { 'x-ratelimit-limit-tokens': '90000' },
    });
  });

  it('throws without apiKey', () => {
    expect(() => new OpenAIProvider({})).toThrow(/OPENAI_API_KEY/i);
  });

  it('passes apiKey to OpenAI constructor', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test-123' });
    expect(shared.ctorOpts).toEqual({ apiKey: 'sk-test-123' });
    expect(typeof p.chat).toBe('function');
  });

  it('calls chat.completions.create with model/messages/tools', async () => {
    const prov = new OpenAIProvider({ apiKey: 'sk-abc' });
    const tools = [{ type: 'function', function: { name: 'doThing', parameters: { type: 'object' } } }];

    await prov.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });

    expect(shared.lastCreateArgs).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
  });

  it('returns normalized message, usage, and headers', async () => {
    const prov = new OpenAIProvider({ apiKey: 'sk-abc' });
    const { message, usage, headers } = await prov.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'go' }],
    });

    expect(message).toEqual({ role: 'assistant', content: 'hello' });
    expect(usage.total_tokens).toBe(321);
    expect(usage.providerRaw).toEqual({ total_tokens: 321, prompt_tokens: 100, completion_tokens: 221 });
    expect(headers).toEqual({ 'x-ratelimit-limit-tokens': '90000' });
  });

  it('handles SDK variants with headers on response.response.headers', async () => {
    shared.responseFactory = () => ({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { total_tokens: 11 },
      response: { headers: { 'x-ratelimit-limit-tokens': '12345' } },
    });

    const prov = new OpenAIProvider({ apiKey: 'sk-abc' });
    const { headers } = await prov.chat({ model: 'gpt-4o', messages: [] });
    expect(headers).toEqual({ 'x-ratelimit-limit-tokens': '12345' });
  });

  it('provides a default assistant message when choices are empty', async () => {
    shared.responseFactory = () => ({
      choices: [],
      usage: {},
      headers: {},
    });

    const prov = new OpenAIProvider({ apiKey: 'sk-abc' });
    const { message } = await prov.chat({ model: 'gpt-4o', messages: [] });
    expect(message).toEqual({ role: 'assistant', content: '' });
  });
});
