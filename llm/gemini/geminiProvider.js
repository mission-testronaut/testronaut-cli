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

// Gemini 3 validates thought signatures on function calls in the current turn.
// Calls synthesized by Testronaut (for example, automatic get_dom calls) were
// not emitted by Gemini and therefore have no real signature to preserve.
// Google documents this sentinel specifically for deterministic client-injected
// function-call history.
const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

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

    // Gemini 3 requires thought signatures to be returned exactly where the
    // model emitted them. Prefer the untouched provider parts when available.
    const geminiParts = m.provider_metadata?.gemini?.parts;
    if (m.role === 'assistant' && Array.isArray(geminiParts) && geminiParts.length) {
      contents.push({ role: 'model', parts: geminiParts });
      continue;
    }

    // Assistant tool calls → Gemini functionCall parts on a model turn
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      contents.push({
        role: 'model',
        parts: m.tool_calls.map((tc, index) => ({
          functionCall: {
            name: tc.function?.name,
            args: safeJsonParse(tc.function?.arguments) ?? {},
          },
          // For parallel calls Gemini expects the signature only on the first
          // functionCall part. Genuine provider parts take the branch above and
          // retain their original signatures instead of receiving this sentinel.
          ...(index === 0 ? { thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE } : {}),
        })),
      });
      continue;
    }

    // Tool results → Gemini function responses. This keeps function-calling
    // history valid for Gemini 3 and gives earlier models structured results.
    if (m.role === 'tool') {
      const parsed = safeJsonParse(m.content);
      const parts = [{
        functionResponse: {
          name: m.name,
          response: parsed ?? { result: m.content },
        },
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
  return {
    role: 'assistant',
    content,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    // Retain all parts, including Gemini 3 thought signatures and function IDs,
    // so the next request can replay them without lossy format conversion.
    provider_metadata: { gemini: { parts } },
  };
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
