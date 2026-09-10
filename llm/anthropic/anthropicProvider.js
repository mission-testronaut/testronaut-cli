import Anthropic from '@anthropic-ai/sdk';

function textBlocks(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: content ?? '' }];
  return parts.map(part => {
    if (typeof part === 'string') return { type: 'text', text: part };
    if (part?.type === 'image') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: Buffer.isBuffer(part.data) ? part.data.toString('base64') : String(part.data ?? ''),
        },
      };
    }
    return { type: 'text', text: part?.text ?? '' };
  });
}

function appendMessage(messages, role, blocks) {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role) {
    const existing = Array.isArray(previous.content)
      ? previous.content
      : [{ type: 'text', text: previous.content }];
    previous.content = [...existing, ...blocks];
  } else {
    messages.push({ role, content: blocks });
  }
}

export function toAnthropicRequest(messages = []) {
  const system = [];
  const converted = [];

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(...textBlocks(message.content).filter(block => block.type === 'text'));
      continue;
    }

    if (message.role === 'tool') {
      appendMessage(converted, 'user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: String(message.content ?? ''),
      }]);
      continue;
    }

    const blocks = textBlocks(message.content).filter(block => block.type !== 'text' || block.text);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* keep safe empty input */ }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input,
        });
      }
    }
    appendMessage(converted, message.role === 'assistant' ? 'assistant' : 'user', blocks);
  }

  return { system, messages: converted };
}

export function fromAnthropicMessage(response) {
  const text = [];
  const tool_calls = [];
  for (const block of response?.content ?? []) {
    if (block.type === 'text') text.push(block.text);
    if (block.type === 'tool_use') {
      tool_calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    role: 'assistant',
    content: text.join(''),
    tool_calls: tool_calls.length ? tool_calls : undefined,
  };
}

export class AnthropicProvider {
  constructor({ apiKey, maxTokens = 8192 } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for Anthropic provider');
    this.client = new Anthropic({ apiKey });
    this.maxTokens = maxTokens;
  }

  async chat({ model, messages, tools }) {
    const converted = toAnthropicRequest(messages);
    const response = await this.client.messages.create({
      model,
      max_tokens: this.maxTokens,
      system: converted.system.length ? converted.system : undefined,
      messages: converted.messages,
      tools: tools?.length ? tools.map(tool => ({
        name: tool.function?.name ?? tool.name,
        description: tool.function?.description ?? tool.description ?? '',
        input_schema: tool.function?.parameters ?? tool.parameters ?? { type: 'object', properties: {} },
      })) : undefined,
    });

    const usage = {
      total_tokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      providerRaw: response.usage,
    };
    return { message: fromAnthropicMessage(response), usage };
  }
}
