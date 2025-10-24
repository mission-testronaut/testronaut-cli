/**
 * llmFactory.js
 * --------------
 * Purpose:
 *   Provide a single entry point to obtain an LLM provider adapter.
 *   Each adapter exposes a unified `chat({ model, messages, tools })`
 *   and returns `{ message, usage }` where `message` is OpenAI-like.
 *
 * Responsibilities:
 *   - Map provider name → concrete adapter instance.
 *   - Normalize constructor options (env API keys + optional overrides).
 *
 * Message contract (internal, OpenAI-like):
 *   - messages: Array<{ role: 'system'|'user'|'assistant'|'tool', content?: string, ... }>
 *   - Assistant tool calls:
 *       message.tool_calls = [{ id, type:'function', function:{ name, arguments:string }}]
 *   - Tool messages:
 *       { role:'tool', tool_call_id, name, type:'function', content:string }
 *
 * Related tests:
 *   Located in `tests/llmTests/llmFactory.test.js`
 *
 * Used by:
 *   - core/turnLoop.js (to obtain the active provider implementation)
 */

import { OpenAIProvider } from './openAI/openaiProvider.js';
import { GeminiProvider } from './gemini/geminiProvider.js';

/**
 * Return an adapter implementing:
 *   chat({ model, messages, tools }) -> Promise<{ message, usage }>
 *
 * @param {string} providerName - 'openai' | 'gemini'
 * @param {object} [opts]       - Optional overrides (e.g., { apiKey, baseURL, ... })
 * @returns {{ chat: Function }} provider adapter
 */
export function getLLM(providerName, opts = {}) {
  switch ((providerName || '').toLowerCase()) {
    case 'openai':
      // NOTE: opts last → caller can override env key if needed (useful for tests)
      return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, ...opts });

    case 'gemini':
      return new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, ...opts });

    default:
      throw new Error(`Unsupported LLM provider: ${providerName}`);
  }
}
