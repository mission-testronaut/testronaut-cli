import OpenAI from 'openai';
import toolsSchema from '../tools/toolSchema.js';
import { CHROME_TOOL_MAP } from '../tools/chromeBrowser.js';
import fs from 'fs';
import { type } from 'os';
import { finalResponseHandler } from '../tools/turnLoopUtils.js';
import { tokenEstimate } from '../tools/tokenControl.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TOKEN_LIMIT_PER_MIN = 90000;
const TOKEN_BACKOFF_MS = 60000;

let totalTokensUsed = 0;
let turnTimestamps = [];

const pushDOMAssistant = async (browser, messages, agentMemory, { skipIfLastTool } = {}) => {
  if (skipIfLastTool && skipIfLastTool.includes(messages.at(-1)?.name)) {
    console.log(`[skip] Skipping DOM push after redundant tool: ${messages.at(-1)?.name}`);
    return;
  }

  const domCallId = `get_dom_${Date.now()}`;

  messages.push({
    role: 'assistant',
    tool_calls: [
      {
        id: domCallId,
        type: 'function',
        function: {
          name: 'get_dom',
          arguments: JSON.stringify({ limit: 100000, exclude: true }),
        },
      },
    ],
  });

  const domHtml = await CHROME_TOOL_MAP.get_dom(browser, { limit: 100000, exclude: true }, agentMemory);
  await tokenEstimate('gpt-4o', domHtml);
  fs.writeFileSync(`debug-expanded-${Date.now()}.html`, domHtml);

  messages.push({
    role: 'tool',
    tool_call_id: domCallId,
    name: 'get_dom',
    type: 'function',
    content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
  });
}

// const pushDOMAssistant = async (browser, messages, { skipIfLastTool } = {}) => {
//   if (skipIfLastTool && skipIfLastTool.includes(messages.at(-1)?.name)) {
//     console.log(`[skip] Skipping DOM push after redundant tool: ${messages.at(-1)?.name}`);
//     return;
//   }

//   let focusHint = null;
//   try {
//     const hintResp = await openai.chat.completions.create({
//       model: 'gpt-4o',
//       messages,
//       tools: [
//         {
//           type: 'function',
//           function: {
//             name: 'get_dom_focus_hint',
//             description: 'Suggests what areas of the DOM to focus on given current agent context',
//             parameters: {
//               type: 'object',
//               properties: {},
//             },
//             required: [],
//           },
//         },
//       ],
//     });
//     const usage = hintResp.usage;
//     if (usage) {
//       console.log(`📊 Token Usage For Hint → Prompt: ${usage.prompt_tokens}, Completion: ${usage.completion_tokens}, Total: ${usage.total_tokens}`);
//       totalTokensUsed += usage?.total_tokens || 0;
//       console.log(`📈 Running Total Tokens Used: ${totalTokensUsed}`);
//     }
//     const hintToolCall = hintResp.choices[0].message.tool_calls?.[0];
//     if (hintToolCall && hintToolCall.function?.arguments) {
//       const parsed = JSON.parse(hintToolCall.function.arguments);
//       if (parsed.focus) {
//         focusHint = parsed.focus;
//         console.log(`🎯 DOM Focus Hint: ${focusHint}`);
//       }
//     }
//   } catch (err) {
//     console.warn('⚠️ Failed to retrieve focus hint:', err.message);
//   }

//   const domCallId = `get_dom_${Date.now()}`;
//   messages.push({
//     role: 'assistant',
//     tool_calls: [
//       {
//         id: domCallId,
//         type: 'function',
//         function: {
//           name: 'get_dom',
//           arguments: JSON.stringify({ limit: 100000, exclude: true, focus: focusHint }),
//         },
//       },
//     ],
//   });

//   const domHtml = await CHROME_TOOL_MAP.get_dom(browser, {
//     limit: 100000,
//     exclude: true,
//     focus: focusHint
//   });
 //   await tokenEstimate('gpt-4o', domHtml);
//   messages.push({
//     role: 'tool',
//     tool_call_id: domCallId,
//     name: 'get_dom',
//     type: 'function',
//     content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
//   });
// };


// const finalResponseHandler = (msg) => {
//   const final = msg.content?.trim().toLowerCase();
//   if (final?.startsWith('success')) {
//     console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
//     console.log(msg.content);
//     console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//     return true;
//   }
//   if (final?.startsWith('failure')) {
//     console.log('\n┏━ FINAL AGENT RESPONSE ━━━━━━━━━━━━━━━━━━━');
//     console.log(msg.content);
//     console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//     return false;
//   }
//   return null;
// }

const wait = (ms) => new Promise(res => setTimeout(res, ms));


export const turnLoop = async (browser, messages, maxTurns, currentTurn = 0, retryCount = 0) => {
  let agentMemory = {
    lastMenuExpanded: false
  };
  
  for (let turn = currentTurn; turn < maxTurns; turn++) {
    console.log(`\n🔄 Turn ${turn + 1}/${maxTurns}`);
    // console.log("current tools", toolsSchema);

    const now = Date.now();
    turnTimestamps = turnTimestamps.filter(ts => now - ts < 60000);

    // if (totalTokensUsed > TOKEN_LIMIT_PER_MIN || turnTimestamps.length >= 5) {
    if (totalTokensUsed > TOKEN_LIMIT_PER_MIN) {
      console.warn(`⚠️ Token throttle risk → Waiting ${TOKEN_BACKOFF_MS / 1000}s to cool off...`);
      await wait(TOKEN_BACKOFF_MS);
      totalTokensUsed = 0; // Reset token count after backoff
      turnTimestamps = []; // Reset timestamps after backoff
      console.log('✅ Backoff complete, resuming...');
      return await turnLoop(browser, messages, maxTurns, turn);
    }

    let response;
    
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools: toolsSchema,
      });
    } catch (err) {
      if (err.status === 429) {
        const delay = Math.min(60000, 2 ** retryCount * 2000);
        console.warn(`⚠️ Rate limited. Retrying in ${delay / 1000}s... (retry ${retryCount + 1})`);
        await wait(delay);

        if (retryCount >= 5) {
          console.error('❌ Too many retries. Exiting.');
          return false;
        }

        return await turnLoop(browser, messages, maxTurns, turn, retryCount + 1);
      } else if (err.status === 400) {
        console.error('❌ Bad request:', err.message);
        console.log("current tools", toolsSchema);
        // console.log("messages", messages);
        return false;
      } else {
        throw err;
      }
    }
    console.log('Response received from OpenAI');
    const usage = response.usage;
    if (usage) {
      console.log(`📊 Token Usage This Turn → Prompt: ${usage.prompt_tokens}, Completion: ${usage.completion_tokens}, Total: ${usage.total_tokens}`);
      totalTokensUsed += usage?.total_tokens || 0;
      turnTimestamps.push(now);
      console.log(`📈 Running Total Tokens Used: ${totalTokensUsed}`);
    }
    const msg = response.choices[0].message;

    if (msg.tool_calls?.length) {
      console.log('Processing tool calls...');
      messages.push(msg);
      let lastToolName = null;
      for (const call of msg.tool_calls) {
        const fnName = call.function.name;
        lastToolName = fnName;
        const args = JSON.parse(call.function.arguments || '{}');
        console.log(`[model] → ${fnName}`, args);
        console.log('Calling tool:', fnName);
        let result;
        try {
          console.log("agentMemory: ", agentMemory);
          result = await CHROME_TOOL_MAP[fnName](browser, args, agentMemory);

          // Smart DOM-ready wait after major actions like click
          // if (['click', 'click_text', 'fill'].includes(fnName)) {
          //   try {
          //     await browser.page.waitForLoadState?.('domcontentloaded', { timeout: 5000 });
          //     await browser.page.waitForTimeout?.(2000); // allow animations/navigation
          //   } catch (err) {
          //     console.warn(`⚠️ DOM readiness wait failed after ${fnName}: ${err.message}`);
          //   }
          // }
          if (typeof result !== 'string') {
            result = JSON.stringify(result ?? '');
          }
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }

        const truncated = result.length > 100 ? result.slice(0, 100) + '…' : result;

        if (result.length > 100) {
          const logFile = `tool-result-${Date.now()}.log`;
          fs.writeFileSync(logFile, result);
          console.log(`[tool ] ← ${truncated} (full output written to ${logFile})`);
        } else {
          console.log(`[tool ] ← ${truncated}`);
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: fnName,
          type: 'function',
          content: result,
        });
        if (fnName === 'expand_menu') {
          agentMemory.lastMenuExpanded = true;
        }
        
        if (fnName === 'click_text' || fnName === 'click' || fnName === 'expand_menu') {
          console.log(`[auto] → Injecting DOM after menu expand...`);
          const domHtml = await CHROME_TOOL_MAP.get_dom(browser, {
            limit: 100000,
            exclude: true,
            focus: [], // or try focusing on ['main'] to keep it light
          }, agentMemory);
          await tokenEstimate('gpt-4o', domHtml);
          fs.writeFileSync(`debug-expanded-${Date.now()}.html`, domHtml);
          await pushDOMAssistant(browser, messages, agentMemory, {
            skipIfLastTool: ['get_dom', 'check_text']
          });
          console.log(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`);
        }
      }

      continue;
    }

    const isAgentDone = finalResponseHandler(msg)
    if (isAgentDone !== null) return isAgentDone;

    await pushDOMAssistant(browser, messages, agentMemory,{
      skipIfLastTool: ['get_dom', 'check_text']
    });

    console.log(`[auto] → Injected DOM for next reasoning step`);
  }
}
