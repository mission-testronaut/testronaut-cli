// tests/llmTests/geminiProvider.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted shared so the mock factory can access/record state
const { shared } = vi.hoisted(() => ({
  shared: {
    apiKey: null,
    getModelOpts: null,
    lastContents: null,
    // default response generator; tests can override
    generateResponse: () => ({
      response: {
        candidates: [
          { content: { parts: [{ text: 'hello' }] } }
        ],
        usageMetadata: { totalTokenCount: 123 },
      },
    }),
  },
}));

// Mock the Google SDK
vi.mock('@google/generative-ai', () => {
  class FakeModel {
    constructor(opts) { shared.getModelOpts = opts; }
    async generateContent({ contents }) {
      shared.lastContents = contents;
      return shared.generateResponse();
    }
  }
  class GoogleGenerativeAI {
    constructor(key) { shared.apiKey = key; }
    getGenerativeModel(opts) { shared.getModelOpts = opts; return new FakeModel(opts); }
  }
  return { GoogleGenerativeAI };
});

// Import SUT after mocks
import { GeminiProvider } from '../../llm/gemini/geminiProvider.js';

describe('GeminiProvider', () => {
  beforeEach(() => {
    shared.apiKey = null;
    shared.getModelOpts = null;
    shared.lastContents = null;
    // reset default response
    shared.generateResponse = () => ({
      response: {
        candidates: [{ content: { parts: [{ text: 'hello' }] } }],
        usageMetadata: { totalTokenCount: 123 },
      },
    });
  });

  it('throws if constructed without apiKey', () => {
    expect(() => new GeminiProvider({})).toThrow(/GEMINI_API_KEY/i);
  });

  it('passes apiKey and model/tools into the SDK correctly', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-123' });

    const tools = [
      { type: 'function', function: { name: 'foo', description: 'Foo', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'bar', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    ];

    await prov.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });

    expect(shared.apiKey).toBe('gk-123');
    expect(shared.getModelOpts?.model).toBe('gemini-2.5-flash');
    // Tools converted to Gemini functionDeclarations wrapper
    expect(Array.isArray(shared.getModelOpts?.tools)).toBe(true);
    expect(shared.getModelOpts.tools[0].functionDeclarations.map(d => d.name)).toEqual(['foo', 'bar']);
  });

  it('strips additionalProperties from tool schemas (unsupported by Gemini)', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-123' });
    const tools = [
      {
        type: 'function',
        function: {
          name: 'set_ground_control_state',
          parameters: {
            type: 'object',
            properties: {
              app: {
                type: 'object',
                additionalProperties: false,
                properties: { baseUrl: { type: 'string' } },
              },
            },
            additionalProperties: false,
          },
        },
      },
    ];

    await prov.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'go' }], tools });

    const decl = shared.getModelOpts.tools[0].functionDeclarations[0];
    expect(decl.parameters.additionalProperties).toBeUndefined();
    expect(decl.parameters.properties.app.additionalProperties).toBeUndefined();
  });

  it('converts OpenAI-like messages → Gemini contents (system prefix + tool calls + tool results)', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-xyz' });

    // Build a conversation:
    // - system
    // - user (should get system prefix injected)
    // - assistant with tool_calls
    // - tool result
    // - assistant normal text
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'search for x' },
      {
        role: 'assistant',
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ q: 'x' }) } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: '1',
        name: 'search',
        type: 'function',
        content: JSON.stringify({ results: [1, 2, 3] }),
      },
      { role: 'assistant', content: 'Here are results.' },
    ];

    await prov.chat({ model: 'gemini-2.5-pro', messages });

    const c = shared.lastContents;
    expect(Array.isArray(c)).toBe(true);

    // 1) First item: user with injected system prefix
    expect(c[0].role).toBe('user');
    expect(c[0].parts[0].text).toMatch(/^\[system]\nYou are helpful\./);
    expect(c[0].parts[1].text).toBe('search for x');

    // 2) Assistant tool call → model role with functionCall
    expect(c[1].role).toBe('model');
    expect(c[1].parts[0]).toEqual({
      functionCall: { name: 'search', args: { q: 'x' } },
      thoughtSignature: 'skip_thought_signature_validator',
    });

    // 3) Tool result → structured Gemini function response
    expect(c[2].role).toBe('user');
    expect(c[2].parts[0].functionResponse).toEqual({
      name: 'search',
      response: { results: [1, 2, 3] },
    });

    // 4) Final assistant text → model role with text
    expect(c[3].role).toBe('model');
    expect(c[3].parts[0].text).toBe('Here are results.');
  });

  it('maps Gemini candidate parts → OpenAI-like assistant message and usage', async () => {
    // Make the fake SDK return a functionCall + text
    shared.generateResponse = () => ({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'open', args: { url: 'https://example.com' } },
                  thoughtSignature: 'encrypted-signature',
                },
                { text: 'Ok!' },
              ],
            },
          },
        ],
        usageMetadata: { totalTokenCount: 999, other: 'meta' },
      },
    });

    const prov = new GeminiProvider({ apiKey: 'gk-abc' });
    const { message, usage } = await prov.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'go' }],
    });

    expect(message.role).toBe('assistant');
    expect(message.content).toBe('Ok!');
    expect(Array.isArray(message.tool_calls)).toBe(true);
    expect(message.tool_calls[0].function.name).toBe('open');
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({ url: 'https://example.com' });
    expect(message.provider_metadata.gemini.parts[0].thoughtSignature).toBe('encrypted-signature');

    expect(usage.total_tokens).toBe(999);
    expect(usage.providerRaw).toEqual({ totalTokenCount: 999, other: 'meta' });
  });

  it('replays Gemini response parts so thought signatures survive tool loops', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-xyz' });
    const signedPart = {
      functionCall: { name: 'click', args: { selector: '#submit' } },
      thoughtSignature: 'opaque-signature',
    };

    await prov.chat({
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'Submit the form' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ type: 'function', function: { name: 'click', arguments: '{"selector":"#submit"}' } }],
          provider_metadata: { gemini: { parts: [signedPart] } },
        },
        { role: 'tool', name: 'click', content: 'Clicked' },
      ],
    });

    expect(shared.lastContents[1]).toEqual({ role: 'model', parts: [signedPart] });
    expect(shared.lastContents[2].parts[0].functionResponse).toEqual({
      name: 'click',
      response: { result: 'Clicked' },
    });
  });

  it('signs deterministic client-injected function calls for Gemini 3 history', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-xyz' });

    await prov.chat({
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'Open the dashboard' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'synthetic-dom',
            type: 'function',
            function: { name: 'get_dom', arguments: '{"selector":"main"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'synthetic-dom', name: 'get_dom', content: '<main>Dashboard</main>' },
      ],
    });

    expect(shared.lastContents[1].parts[0]).toEqual({
      functionCall: { name: 'get_dom', args: { selector: 'main' } },
      thoughtSignature: 'skip_thought_signature_validator',
    });
  });

  it('adds the synthetic signature only to the first parallel function call', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-xyz' });

    await prov.chat({
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'Inspect both regions' },
        {
          role: 'assistant',
          tool_calls: [
            { type: 'function', function: { name: 'get_dom', arguments: '{"selector":"main"}' } },
            { type: 'function', function: { name: 'get_dom', arguments: '{"selector":"nav"}' } },
          ],
        },
      ],
    });

    expect(shared.lastContents[1].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(shared.lastContents[1].parts[1].thoughtSignature).toBeUndefined();
  });

  it('supports image parts (encoded to inlineData)', async () => {
    const prov = new GeminiProvider({ apiKey: 'gk-xyz' });

    const imageBytes = Buffer.from([1, 2, 3, 4]);
    await prov.chat({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see image' },
            { type: 'image', mimeType: 'image/png', data: imageBytes },
          ],
        },
      ],
    });

    const c = shared.lastContents;
    expect(c[0].role).toBe('user');
    expect(c[0].parts[0].text).toBe('see image');
    expect(c[0].parts[1].inlineData.mimeType).toBe('image/png');
    expect(typeof c[0].parts[1].inlineData.data).toBe('string'); // base64
  });
});
