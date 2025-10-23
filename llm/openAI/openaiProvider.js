import OpenAI from 'openai';

export class OpenAIProvider {
  constructor({ apiKey } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI provider');
    this.client = new OpenAI({ apiKey });
  }

  /**
   * @param {{model:string, messages:any[], tools?:any[]}} params
   * @returns {Promise<{message:any, usage?:{total_tokens?:number, providerRaw?:any}, headers?:any}>}
   */
  async chat({ model, messages, tools }) {
    const res = await this.client.chat.completions.create({
      model,
      messages,
      tools,
    });

    // OpenAI already returns OpenAI-like message (+ usage)
    const message = res.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    const usage = {
      total_tokens: res.usage?.total_tokens,
      providerRaw: res.usage,
    };
    // headers are useful for your rate-limit learner
    const headers = res.headers || res.response?.headers;

    return { message, usage, headers };
  }
}
