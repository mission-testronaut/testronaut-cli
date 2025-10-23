/**
 * LLM factory & common types
 * --------------------------
 * Exposes a single `getLLM(provider)` that returns a provider adapter
 * implementing `chat({ model, messages, tools }) -> { message, usage }`.
 *
 * Message contract (internal, OpenAI-like):
 * - `messages`: Array of chat messages with roles 'system' | 'user' | 'assistant' | 'tool'
 * - Assistant tool calls use: message.tool_calls = [{ id, type:'function', function:{ name, arguments:string }}]
 * - Tool messages use: { role:'tool', tool_call_id, name, type:'function', content:string }
 *
 * Each adapter converts to its native API and returns:
 * - { message, usage }
 *   where `message` is normalized back to OpenAI-like,
 *   and `usage = { total_tokens?: number, providerRaw?: any }`
 */

import { OpenAIProvider } from './openAI/openaiProvider.js';
import { GeminiProvider } from './gemini/geminiProvider.js';

export function getLLM(providerName, opts = {}) {
  switch ((providerName || '').toLowerCase()) {
    case 'openai':
      return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, ...opts });
    case 'gemini':
      return new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, ...opts });
    default:
      throw new Error(`Unsupported LLM provider: ${providerName}`);
  }
}
