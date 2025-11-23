/**
 * geminiProvider.js
 * ------------------
 * Purpose:
 *   Adapter that normalizes Testronaut's OpenAI-like chat format to
 *   Google Gemini's SDK and back. Exposes a single `chat()` method.
 *
 * Responsibilities:
 *   - Convert OpenAI-like messages → Gemini "contents" (roles/parts).
 *   - Map tool/function calling both ways:
 *       • assistant.tool_calls → Gemini functionCall parts
 *       • tool messages → user parts (so the model can read results)
 *   - Return an OpenAI-like assistant message and usage metadata.
 *
 * Message contract (OpenAI-like, internal):
 *   - messages: Array<{ role: 'system'|'user'|'assistant'|'tool', content?: string|Array, ... }>
 *   - Assistant tool calls:
 *       message.tool_calls = [{ id, type:'function', function:{ name, arguments:string }}]
 *   - Tool messages:
 *       { role:'tool', tool_call_id, name, type:'function', content:string }
 *
 * Related tests:
 *   Located in `tests/llmTests/geminiProvider.test.js`
 *
 * Used by:
 *   - llm/llmFactory.js
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Convert OpenAI-like messages → Gemini "contents" array.
 * - System messages are coalesced and injected as a prefix into the next user turn.
 * - Assistant tool calls are represented as model turns with functionCall parts.
 * - Tool results are encoded as a user turn with a JSON payload part.
 * - Text/images are mapped to Gemini `parts` (text / inlineData).
 */
function toGeminiContents(messages) {
  const contents = [];
  let systemPrefix = '';

  for (const m of messages) {
    if (m.role === 'system') {
      // Collect multi-system messages; inject once on the next user message
      const sysText = Array.isArray(m.content)
        ? m.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')
        : (m.content || '');
      systemPrefix += (systemPrefix ? '\n' : '') + sysText;
      continue;
    }

    // Assistant tool calls → Gemini functionCall parts on a model turn
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
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

    // Tool results → encode as a user turn with a JSON part the model can parse
    if (m.role === 'tool') {
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

    // Normal user/assistant content (text and/or images)
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

    // Include system prefix exactly once on the first user turn after system
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

// Gemini's functionDeclarations reject JSON Schema's `additionalProperties`; prune it recursively.
function stripAdditionalProperties(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripAdditionalProperties);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'additionalProperties') continue; // Gemini function declarations do not support this key
    out[k] = stripAdditionalProperties(v);
  }
  return out;
}

/**
 * Convert a Gemini candidate → OpenAI-like assistant message.
 * - Collects text parts into `content`.
 * - Translates functionCall parts into `tool_calls`.
 */
function fromGeminiCandidate(cand) {
  const parts = cand?.content?.parts ?? [];
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
   * Execute a chat turn via Gemini and normalize the response.
   * @param {{model:string, messages:any[], tools?:any[]}} params
   * @returns {Promise<{message:any, usage?:{total_tokens?:number, providerRaw?:any}}>}
   */
  async chat({ model, messages, tools }) {
    // Map OpenAI-like tool schema → Gemini functionDeclarations
    const genTools = tools?.length
      ? [{
          functionDeclarations: tools.map(t => ({
            name: t.function?.name ?? t.name,
            description: t.description ?? '',
            parameters: stripAdditionalProperties(t.function?.parameters ?? t.parameters ?? {}), // JSON schema sans additionalProperties (unsupported by Gemini)
          })),
        }]
      : undefined;

    const gmodel = this.client.getGenerativeModel({
      model,
      tools: genTools,
      generationConfig: {}, // temperature/topP can be added upstream if needed
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
