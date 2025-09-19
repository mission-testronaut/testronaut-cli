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
  pruneOldTokenUsage,
  getCurrentTokenLimit,
  updateLimitsFromHeaders
} from '../tools/tokenControl.js';
import { resolveModel } from '../openAI/modelResolver.js';


const MODEL_ID = resolveModel();
console.log(`🧠 Using OpenAI model: ${MODEL_ID}`);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let totalTokensUsed = 0;
let turnTimestamps = [];
let shouldBackoff;
let steps = [];

function formatBytes(n) {
  if (!Number.isFinite(n)) return `${n}`;
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

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
  await tokenEstimate( MODEL_ID, domHtml);
  // fs.writeFileSync(`missions/mission_reports/debug-expanded-${Date.now()}.html`, domHtml);

  messages.push({
    role: 'tool',
    tool_call_id: domCallId,
    name: 'get_dom',
    type: 'function',
    content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
  });
}

export const turnLoop = async (
  browser, 
  messages, 
  maxTurns, 
  currentTurn = 0, 
  retryCount = 0, 
  currentStep = {},
  ctx = {} // 👈 { steps, missionName }
) => {
  const { steps = [], missionName } = ctx;
  let agentMemory = {
    lastMenuExpanded: false
  };
  
  for (let turn = currentTurn; turn < maxTurns; turn++) {
    console.log(`\n🔄 Turn ${turn + 1}/${maxTurns}`);
    let response;
    // const currentStep = { turn, events: [], result: '🟡 In Progress' };
    const currentStep = { turn, events: [], result: '🟡 In Progress', missionName }; // 👈 tag it
    try {

      // Recalculate the rolling window before checking cooldown
      ({ turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(turnTimestamps));

      // Cool off check
      ({ totalTokensUsed, turnTimestamps, shouldBackoff } = await tokenUseCoolOff(totalTokensUsed, turnTimestamps, MODEL_ID));
      if(shouldBackoff) return await turnLoop(browser, messages, maxTurns, turn, currentStep);

      //Tool Validator
      if (!validateAndInsertMissingToolResponses(messages, { insertPlaceholders: true })) {
        console.error('❌ Tool call structure invalid and no placeholders inserted.');
        currentStep.events.push('❌ Tool call structure invalid and no placeholders inserted.')
        currentStep.result = '❌ Failure';
        steps.push(currentStep);
        return steps;
      }

      const unrespondedCalls = messages.filter(
        (msg, i) =>
          msg.role === 'assistant' &&
          msg.tool_calls?.length &&
          !msg.tool_calls.every(call =>
            messages.slice(i + 1).some(
              m => m.role === 'tool' && m.tool_call_id === call.id
            )
          )
      );
      
      if (unrespondedCalls.length) {
        console.error('🛑 Detected assistant tool calls without matching tool responses:');
        console.dir(unrespondedCalls, { depth: 5 });
        currentStep.events.push('🛑 Detected assistant tool calls without matching tool responses')
        currentStep.result = '❌ Failure';
        steps.push(currentStep);
        return steps;
      }
      

      response = await openai.chat.completions.create({
        model: MODEL_ID,
        messages,
        tools: toolsSchema,
      });
    } catch (err) {
      if (err.status === 429) {
        // If headers include limits, learn them for this model
        try { updateLimitsFromHeaders(MODEL_ID, err.headers || err.response?.headers || {}); } catch {}
        const delay = Math.min(60000, 2 ** retryCount * 2000);
        console.warn(`⚠️ Rate limited. Retrying in ${delay / 1000}s... (retry ${retryCount + 1})`);
        await wait(delay);

        if (retryCount >= 5) {
          console.error('❌ Too many retries. Exiting.');
          currentStep.events.push('❌ Too many retries. Exiting.')
          currentStep.result = '❌ Failure';
          steps.push(currentStep);
          return steps;
        }

        return await turnLoop(browser, messages, maxTurns, turn, retryCount + 1, currentStep);
      } else if (err.status === 400) {
        console.error('❌ Bad request:', err.message);
        // console.log("current tools", toolsSchema);
        // console.log("messages: ", messages)
        currentStep.events.push(`❌ Bad request: ${err.message}`)
        currentStep.result = '❌ Failure';
        steps.push(currentStep);
        return steps;
      } else {
        throw err;
      }
    }
    console.log('Response received from OpenAI');
    const usage = response.usage;
    if (usage) {
      const tokensUsed = usage.total_tokens || 0;
      console.log(`📊 Token Usage This Turn → Total: ${tokensUsed}`);
      currentStep.tokensUsed = tokensUsed;
      recordTokenUsage(turnTimestamps, tokensUsed);
      ({ turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(turnTimestamps));

      console.log(`📈 Running Total Tokens Used (Rolling 60s): ${totalTokensUsed}`);
      currentStep.totalTokensUsed = totalTokensUsed;
    }
    
    const msg = response.choices[0].message;

    if (msg.tool_calls?.length) {
      console.log('Processing tool calls...');
      const toolResponses = [];
      let lastToolName = null;

      for (const call of msg.tool_calls) {
        const fnName = call.function.name;
        lastToolName = fnName;
        const args = JSON.parse(call.function.arguments || '{}');
        console.log(`[model] → ${fnName}`, args);
        currentStep.events.push(`[model] → ${fnName} ${args}`);
        // console.log('Calling tool:', fnName);
        let result;
        let errorMessage = null;
        try {
          // console.log("agentMemory: ", agentMemory);
          result = await CHROME_TOOL_MAP[fnName](browser, args, agentMemory);

          if (typeof result !== 'string') {
            result = JSON.stringify(result ?? '');
          }
        } catch (err) {
          errorMessage = `ERROR: ${err.message}`;
          result = errorMessage;
        }

        // ------ Capture file upload/download events for mission report ------
        try {
          const maybeJson = JSON.parse(result);
          if (maybeJson && maybeJson._testronaut_file_event) {
            currentStep.files = currentStep.files || [];
            currentStep.files.push(maybeJson);

            if (maybeJson._testronaut_file_event === 'upload') {
              const msgLine = `📤 Uploaded "${maybeJson.fileName}" (${formatBytes(maybeJson.bytes)}) via ${maybeJson.method}`;
              currentStep.events.push(msgLine);
              console.log(msgLine);
            } else if (maybeJson._testronaut_file_event === 'download') {
              const msgLine = `📥 Downloaded "${maybeJson.fileName}" (${formatBytes(maybeJson.bytes)}) via ${maybeJson.mode}`;
              currentStep.events.push(msgLine);
              console.log(msgLine);
            }
          }
        } catch { /* not JSON / ignore */ }

        console.log(`[tool ] ← ${fnName} result:`, errorMessage ? '❌ Failed' : '✅ Success');
        currentStep.events.push(`[tool ] ← ${fnName} result: ${errorMessage ? '❌ Failed' : '✅ Success'}`)
        const truncated = result.length > 100 ? result.slice(0, 100) + '…' : result;
        console.log(`[tool ] ← ${truncated}`);

        if (fnName === 'screenshot') {
          const match = result.match(/screenshot.*?saved at: (.+\.png)/i);
          if (match && match[1]) {
            currentStep.screenshotPath = match[1];
            currentStep.events.push(`🖼️ Screenshot captured: ${match[1]}`);
          }
        }
        
        currentStep.events.push(`[tool ] ← ${truncated}`)
        toolResponses.push({
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
          currentStep.events.push(`[auto] → Injecting DOM after menu expand...`);
          const domHtml = await CHROME_TOOL_MAP.get_dom(browser, {
            limit: 100000,
            exclude: true,
            focus: [],
          }, agentMemory);
          await tokenEstimate(MODEL_ID, domHtml);
          await pushDOMAssistant(browser, messages, agentMemory, {
            skipIfLastTool: ['get_dom', 'check_text']
          });
          console.log(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`);
          currentStep.events.push(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`)
        }
        
      }
      messages.push(msg, ...toolResponses);
      currentStep.result = '✅ Passed';
      steps.push(currentStep);
      continue;
    }

    const finalResponse = finalResponseHandler(msg);
    if (finalResponse !== null) {
      currentStep.events.push(finalResponse.finalMessage);
      currentStep.result = finalResponse.success ? '✅ Mission Success': '❌ Mission Failure';
      steps.push(currentStep);
      return { success: finalResponse.finalMessage, steps };
    }


    await pushDOMAssistant(browser, messages, agentMemory,{
      skipIfLastTool: ['get_dom', 'check_text']
    });

    console.log(`[auto] → Injected DOM for next reasoning step`);
    currentStep.events.push(`[auto] → Injected DOM for next reasoning step`)
  }
}
