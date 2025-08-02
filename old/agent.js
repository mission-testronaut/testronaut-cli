// agent.js — Autonomous web agent with auto DOM refresh between steps

import 'dotenv/config';
import OpenAI from 'openai';
import { chromium } from 'playwright';

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

  async click({ selector }) {
    await this.page.waitForSelector(selector, { timeout: 30_000 });
    await this.page.click(selector);
    return `clicked ${selector}`;
  }

  async get_dom({ limit = 5000 }) {
    const html = await this.page.content();
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
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dom',
      description: 'Return trimmed HTML content for GPT to inspect and find selectors',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 5000 },
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
        messages.push(msg); // assistant's intent

        for (const call of msg.tool_calls) {
          const fnName = call.function.name;
          const args = JSON.parse(call.function.arguments || '{}');
          console.log(`[model] → ${fnName}`, args);

          try {
            let result;
            try {
              result = await TOOL_MAP[fnName](browser, args);
              if (typeof result !== 'string') {
                result = JSON.stringify(result ?? ''); // make sure it's always a string
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
          } catch (err) {
            console.error(`[error] ${err.message}`);
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: fnName,
              content: `ERROR: ${err.message}`,
            });
          }
        }

        continue;
      }

      // Check if GPT declared final answer
      const final = msg.content?.trim().toLowerCase();
      if (final?.startsWith('success') || final?.startsWith('failure')) {
        console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
        console.log(msg.content);
        console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return;
      }

      // Otherwise, auto-inject get_dom so GPT can see the page
      const domCallId = `get_dom_${Date.now()}`;
      const domAssistantMsg = {
        role: 'assistant',
        tool_calls: [
          {
            id: domCallId,
            function: {
              name: 'get_dom',
              arguments: JSON.stringify({ limit: 5000 }),
            },
          },
        ],
      };
      messages.push(domAssistantMsg);

      const domHtml = await TOOL_MAP.get_dom(browser, { limit: 5000 });
      messages.push({
        role: 'tool',
        tool_call_id: domCallId,
        name: 'get_dom',
        content: domHtml,
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
    Visit https://staging.collegiumbuilt.com/login.
    Log in using owner@collegiumbuilt.com and password C0ll3g1um_Bu1lt!.
    After clicking the login button, if you see the word "Dashboard" on the page, report SUCCESS.
    Otherwise, report FAILURE.
  `);
})();
