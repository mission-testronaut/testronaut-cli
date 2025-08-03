import OpenAI from 'openai';
import toolsSchema from '../tools/toolSchema.js';
import { CHROME_TOOL_MAP } from '../tools/chromeBrowser.js';
import fs from 'fs';
import { 
  finalResponseHandler, 
  wait, 
  validateAndInsertMissingToolResponses 
} from '../tools/turnLoopUtils.js';
import { 
  tokenEstimate, 
  tokenUseCoolOff, 
  recordTokenUsage, 
  pruneOldTokenUsage 
} from '../tools/tokenControl.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

export const turnLoop = async (browser, messages, maxTurns, currentTurn = 0, retryCount = 0) => {
  let agentMemory = {
    lastMenuExpanded: false
  };
  
  for (let turn = currentTurn; turn < maxTurns; turn++) {
    console.log(`\n🔄 Turn ${turn + 1}/${maxTurns}`);
    // console.log("current tools", toolsSchema);

    // const now = Date.now();
    // turnTimestamps = turnTimestamps.filter(ts => now - ts < 60000);

    // Recalculate the rolling window before checking cooldown
    const pruned = pruneOldTokenUsage(turnTimestamps);
    turnTimestamps = pruned.turnTimestamps;
    totalTokensUsed = pruned.totalTokensUsed;

    // Cool off check
    const cooldownResult = await tokenUseCoolOff(totalTokensUsed, turnTimestamps);
    totalTokensUsed = cooldownResult.totalTokensUsed;
    turnTimestamps = cooldownResult.turnTimestamps;
    if (cooldownResult.shouldBackoff) {
      return await turnLoop(browser, messages, maxTurns, turn);
    }
    // if (await tokenUseCoolOff(totalTokensUsed, turnTimestamps)) {return await turnLoop(browser, messages, maxTurns, turn)}

    const isValid = validateAndInsertMissingToolResponses(messages, {
      insertPlaceholders: true, // safe fallback behavior
    });
    
    if (!isValid) {
      console.error('❌ Tool call structure invalid and no placeholders inserted.');
      return false;
    }
    // console.log(JSON.stringify(messages, null, 2));

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
        return false;
      } else {
        throw err;
      }
    }
    console.log('Response received from OpenAI');
    const usage = response.usage;
    // if (usage) {
    //   console.log(`📊 Token Usage This Turn → Prompt: ${usage.prompt_tokens}, Completion: ${usage.completion_tokens}, Total: ${usage.total_tokens}`);
    //   totalTokensUsed += usage?.total_tokens || 0;
    //   turnTimestamps.push(now);
    //   console.log(`📈 Running Total Tokens Used: ${totalTokensUsed}`);
    // }
    if (usage) {
      const tokensUsed = usage.total_tokens || 0;
      console.log(`📊 Token Usage This Turn → Total: ${tokensUsed}`);
      recordTokenUsage(turnTimestamps, tokensUsed);
      const pruned = pruneOldTokenUsage(turnTimestamps);
      turnTimestamps = pruned.turnTimestamps;
      totalTokensUsed = pruned.totalTokensUsed;
      console.log(`📈 Running Total Tokens Used (Rolling 60s): ${totalTokensUsed}`);
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
