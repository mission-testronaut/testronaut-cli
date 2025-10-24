/**
 * openaiProvider.js
 * ------------------
 * Purpose:
 *   Adapter that wraps OpenAI's SDK and exposes a normalized `chat()` API
 *   consistent with Testronaut’s OpenAI-like message format.
 *
 * Responsibilities:
 *   - Call OpenAI Chat Completions with { model, messages, tools }.
 *   - Return { message, usage, headers } where:
 *       • message is OpenAI-like (already native)
 *       • usage.total_tokens is forwarded from OpenAI
 *       • headers (if present) can be used by the token limit learner
 *
 * Related tests:
 *   Located in `tests/llmTests/openAIProvider.test.js`
 *
 * Used by:
 *   - llm/llmFactory.js
 */

import OpenAI from 'openai';

export class OpenAIProvider {
  constructor({ apiKey } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI provider');
    this.client = new OpenAI({ apiKey });
  }

  /**
   * Execute a chat turn via OpenAI and normalize the response.
   * @param {{model:string, messages:any[], tools?:any[]}} params
   * @returns {Promise<{message:any, usage?:{total_tokens?:number, providerRaw?:any}, headers?:any}>}
   */
  async chat({ model, messages, tools }) {
    const res = await this.client.chat.completions.create({
      model,
      messages,
      tools,
    });

    // OpenAI already returns an OpenAI-like message and usage structure.
    const message = res.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    const usage = {
      total_tokens: res.usage?.total_tokens,
      providerRaw: res.usage,
    };

    // Some SDK versions surface headers on `res.headers`, others on `res.response.headers`.
    const headers = res.headers || res.response?.headers;

    return { message, usage, headers };
  }
}
