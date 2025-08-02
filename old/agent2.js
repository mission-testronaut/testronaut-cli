// agent.js — Autonomous web agent with exclusion-based DOM trimming

import 'dotenv/config';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class Browser {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async start() {
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
  }

  async navigate({ url }) {
    await this.page.goto(url, { timeout: 30_000 });
    return `navigated to ${this.page.url()}`;
  }

  async fill({ selector, text }) {
    await this.page.waitForSelector(selector, { timeout: 30_000 });
    await this.page.fill(selector, text);
    return `filled ${selector}`;
  }

  async click({ selector, waitFor = 'load' }) {
    await this.page.waitForSelector(selector, { timeout: 30_000 });
  
    // Wait for possible page navigation or DOM change after click
    const [response] = await Promise.all([
      this.page.waitForLoadState(waitFor, { timeout: 10_000 }).catch(() => null), // wait for network/DOM
      this.page.click(selector),
    ]);
  
    return `clicked ${selector}`;
  }  

  async get_dom({ limit = 5000, exclude = true }) {
    const html = await this.page.content();

    if (exclude) {
      const $ = cheerio.load(html);
      $('script, style, meta, link, noscript, iframe, canvas, svg').remove();

      $('*').each((_, el) => {
        const $el = $(el);
        if (!$el.text().trim() && $el.children().length === 0) {
          $el.remove();
        }
      });

      $('*')
        .contents()
        .each(function () {
          if (this.type === 'comment') {
            $(this).remove();
          }
        });

      return $.html().slice(0, limit);
    }

    return html.slice(0, limit);
  }

  async close() {
    await this.browser?.close();
  }
}

const toolsSchema = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate to a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Fill in a field by CSS selector',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click a button or link by CSS selector',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          waitFor: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            default: 'load',
            description: 'Wait condition after click',
          },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dom',
      description: 'Return trimmed HTML from the current page',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            default: 5000,
            description: 'Max characters to return',
          },
          exclude: {
            type: 'boolean',
            default: true,
            description: 'Whether to exclude noisy tags like script/style/etc.',
          },
        },
      },
    },
  },
];

const TOOL_MAP = {
  navigate: (b, args) => b.navigate(args),
  fill: (b, args) => b.fill(args),
  click: (b, args) => b.click(args),
  get_dom: (b, args) => b.get_dom(args),
};

async function runAgent(goal, maxTurns = 10) {
  const browser = new Browser();
  await browser.start();

  const messages = [
    {
      role: 'system',
      content: `
        You are an autonomous web agent. Use function calls to complete the user's goal.
        If you are unsure of the selectors for inputs or buttons, call 'get_dom' to retrieve page HTML,
        analyze it, then make your best guess based on labels, names, types, and placeholder values.
        After completing the goal, respond with a final plain-text message starting with SUCCESS or FAILURE.
      `.trim(),
    },
    { role: 'user', content: goal },
  ];

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools: toolsSchema,
      });

      const msg = response.choices[0].message;

      if (msg.tool_calls?.length) {
        messages.push(msg);

        for (const call of msg.tool_calls) {
          const fnName = call.function.name;
          const args = JSON.parse(call.function.arguments || '{}');
          console.log(`[model] → ${fnName}`, args);

          let result;
          try {
            result = await TOOL_MAP[fnName](browser, args);
            if (typeof result !== 'string') {
              result = JSON.stringify(result ?? '');
            }
          } catch (err) {
            result = `ERROR: ${err.message}`;
          }

          console.log(`[tool ] ← ${result}`);

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: fnName,
            content: result,
          });
        }

        continue;
      }

      const final = msg.content?.trim().toLowerCase();
      if (final?.startsWith('success') || final?.startsWith('failure')) {
        console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
        console.log(msg.content);
        console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return;
      }

      const domCallId = `get_dom_${Date.now()}`;
      messages.push({
        role: 'assistant',
        tool_calls: [
          {
            id: domCallId,
            function: {
              name: 'get_dom',
              arguments: JSON.stringify({ limit: 5000, exclude: true }),
            },
          },
        ],
      });

      const domHtml = await TOOL_MAP.get_dom(browser, { limit: 5000, exclude: true });
      messages.push({
        role: 'tool',
        tool_call_id: domCallId,
        name: 'get_dom',
        content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
      });

      console.log(`[auto] → Injected DOM for next reasoning step`);
    }

    console.log('🛑 Agent ran out of turns.');
  } finally {
    await browser.close();
  }
}

(async () => {
  await runAgent(`
    Visit ${process.env.URL}.
    Log in using ${process.env.USERNAME} and password C0ll3g1um_Bu1lt!.
    After clicking the login button, if you see the word "${process.env.AFTER_LOGIN_CHECK}" on the page, report SUCCESS.
    Otherwise, report FAILURE.
  `);
})();
