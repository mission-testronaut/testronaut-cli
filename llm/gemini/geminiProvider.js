import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Converts OpenAI-like messages to Gemini "contents"
 */
function toGeminiContents(messages) {
  const contents = [];
  let systemPrefix = '';

  for (const m of messages) {
    if (m.role === 'system') {
      const sysText = Array.isArray(m.content)
        ? m.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')
        : (m.content || '');
      systemPrefix += (systemPrefix ? '\n' : '') + sysText;
      continue;
    }

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // Represent assistant tool calls as function calls in a model turn.
      contents.push({
        role: 'model',
        parts: m.tool_calls.map(tc => ({
          functionCall: {
            name: tc.function?.name,
            args: safeJsonParse(tc.function?.arguments) ?? {},
          },
        })),
      });
      continue;
    }

    if (m.role === 'tool') {
      // Return tool results as user parts so model can consume them next turn
      const parts = [{
        text: JSON.stringify({
          _tool_result: true,
          tool_call_id: m.tool_call_id,
          name: m.name,
          content: m.content,
        }),
      }];
      contents.push({ role: 'user', parts });
      continue;
    }

    // Normal user/assistant text messages
    const baseParts = [];
    const asArray = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const p of asArray) {
      if (p?.type === 'image') {
        baseParts.push({
          inlineData: {
            mimeType: p.mimeType,
            data: Buffer.from(p.data).toString('base64'),
          }
        });
      } else {
        baseParts.push({ text: typeof p === 'string' ? p : (p.text ?? '') });
      }
    }

    // Include system prefix on the first user turn after system
    if (systemPrefix && m.role === 'user') {
      baseParts.unshift({ text: `[system]\n${systemPrefix}` });
      systemPrefix = '';
    }

    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: baseParts });
  }

  return contents;
}

function safeJsonParse(s) {
  try { return JSON.parse(s ?? '{}'); } catch { return null; }
}

/**
 * Converts Gemini response to OpenAI-like assistant message
 */
function fromGeminiCandidate(cand) {
  const parts = cand?.content?.parts ?? [];
  // Tool calls appear as functionCall parts; text parts as .text
  const tool_calls = [];
  const texts = [];

  for (const p of parts) {
    if (p.functionCall) {
      tool_calls.push({
        id: cryptoRandomId(),
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        }
      });
    } else if (typeof p.text === 'string') {
      texts.push(p.text);
    }
  }

  const content = texts.join('');
  return { role: 'assistant', content, tool_calls: tool_calls.length ? tool_calls : undefined };
}

function cryptoRandomId() {
  return 'tool_' + Math.random().toString(36).slice(2);
}

export class GeminiProvider {
  constructor({ apiKey } = {}) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required for Gemini provider');
    this.client = new GoogleGenerativeAI(apiKey);
  }

  /**
   * @param {{model:string, messages:any[], tools?:any[]}} params
   * @returns {Promise<{message:any, usage?:{total_tokens?:number, providerRaw?:any}}>}
   */
  async chat({ model, messages, tools }) {
    const genTools = tools?.length
      ? [{ functionDeclarations: tools.map(t => ({
            name: t.function?.name ?? t.name,
            description: t.description ?? '',
            parameters: t.function?.parameters ?? t.parameters ?? {}, // JSON schema
          }))
        }]
      : undefined;

    const gmodel = this.client.getGenerativeModel({
      model,
      tools: genTools,
      generationConfig: {}, // temperature handled upstream if needed
    });

    const contents = toGeminiContents(messages);
    const res = await gmodel.generateContent({ contents });

    const cand = res?.response?.candidates?.[0];
    const message = fromGeminiCandidate(cand);

    const usageMeta = res?.response?.usageMetadata;
    const usage = {
      total_tokens: usageMeta?.totalTokenCount,
      providerRaw: usageMeta,
    };

    return { message, usage };
  }
}
