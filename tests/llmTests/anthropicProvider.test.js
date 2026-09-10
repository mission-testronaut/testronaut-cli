import { describe, it, expect, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic { constructor(options) { this.options = options; this.messages = { create }; } },
}));

import { AnthropicProvider, fromAnthropicMessage, toAnthropicRequest } from '../../llm/anthropic/anthropicProvider.js';

describe('AnthropicProvider', () => {
  it('requires an API key', () => {
    expect(() => new AnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('converts system, images, tool calls, and tool results', () => {
    const request = toAnthropicRequest([
      { role: 'system', content: 'Be precise' },
      { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', mimeType: 'image/png', data: Buffer.from('png') }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'click', arguments: '{"selector":"#go"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'clicked' },
    ]);
    expect(request.system).toEqual([{ type: 'text', text: 'Be precise' }]);
    expect(request.messages[0].content[1].source).toMatchObject({ type: 'base64', media_type: 'image/png' });
    expect(request.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'click' });
    expect(request.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
  });

  it('normalizes Claude output and usage', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Working' }, { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: { url: 'https://example.com' } }],
      usage: { input_tokens: 12, output_tokens: 8 },
    });
    const result = await new AnthropicProvider({ apiKey: 'sk-ant-test' }).chat({
      model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Go' }],
      tools: [{ type: 'function', function: { name: 'navigate', description: 'Navigate', parameters: { type: 'object' } } }],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5', max_tokens: 8192 }));
    expect(result.message).toEqual(fromAnthropicMessage({ content: [{ type: 'text', text: 'Working' }, { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: { url: 'https://example.com' } }] }));
    expect(result.usage.total_tokens).toBe(20);
  });
});
