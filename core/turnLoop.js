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
import { resolveProviderModel } from '../llm/modelResolver.js';
import { getLLM } from '../llm/llmFactory.js';
import { summarizeTurnIntentFromMessage } from './turnIntent.js';
import { redactArgs } from './redaction.js';

const { provider: PROVIDER_ID, model: MODEL_ID } = resolveProviderModel();
console.log(`🧠 Using LLM → provider: ${PROVIDER_ID}, model: ${MODEL_ID}`);

const llm = getLLM(PROVIDER_ID);

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

  // Inject an assistant tool call (OpenAI-like shape)
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
  await tokenEstimate(MODEL_ID, domHtml);

  messages.push({
    role: 'tool',
    tool_call_id: domCallId,
    name: 'get_dom',
    type: 'function',
    content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
  });
};

export const turnLoop = async (
  browser, 
  messages, 
  maxTurns, 
  currentTurn = 0, 
  retryCount = 0, 
  currentStep = {},
  ctx = {} // { steps, missionName }
) => {
  const { steps = [], missionName } = ctx;
  let agentMemory = { lastMenuExpanded: false };
  
  for (let turn = currentTurn; turn < maxTurns; turn++) {
    console.log(`\n🔄 Turn ${turn + 1}/${maxTurns}`);
    let response;
    const step = { turn, events: [], result: '🟡 In Progress', missionName };

    try {
      ({ turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(turnTimestamps));

      ({ totalTokensUsed, turnTimestamps, shouldBackoff } = await tokenUseCoolOff(totalTokensUsed, turnTimestamps, MODEL_ID));
      if (shouldBackoff) return await turnLoop(browser, messages, maxTurns, turn, currentStep);

      //Tool Validator
      if (!validateAndInsertMissingToolResponses(messages, { insertPlaceholders: true })) {
        console.error('❌ Tool call structure invalid and no placeholders inserted.');
        step.events.push('❌ Tool call structure invalid and no placeholders inserted.');
        step.result = '❌ Failure';
        steps.push(step);
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
        step.events.push('🛑 Detected assistant tool calls without matching tool responses');
        step.result = '❌ Failure';
        steps.push(step);
        return steps;
      }

      // ✅ Provider-agnostic chat
      const { message, usage, headers } = await llm.chat({
        model: MODEL_ID,
        messages,
        tools: toolsSchema
      });

      response = { message, usage, headers };
    } catch (err) {
      if (err.status === 429) {
        // Provider may expose headers; only OpenAI uses updateLimitsFromHeaders currently
        try { updateLimitsFromHeaders(MODEL_ID, err.headers || err.response?.headers || {}); } catch {}
        const delay = Math.min(60000, 2 ** retryCount * 2000);
        console.warn(`⚠️ Rate limited. Retrying in ${delay / 1000}s... (retry ${retryCount + 1})`);
        await wait(delay);

        if (retryCount >= 5) {
          console.error('❌ Too many retries. Exiting.');
          step.events.push('❌ Too many retries. Exiting.');
          step.result = '❌ Failure';
          steps.push(step);
          return steps;
        }
        return await turnLoop(browser, messages, maxTurns, turn, retryCount + 1, step);
      } else if (err.status === 400) {
        console.error('❌ Bad request:', err.message);
        step.events.push(`❌ Bad request: ${err.message}`);
        step.result = '❌ Failure';
        steps.push(step);
        return steps;
      } else {
        throw err;
      }
    }

    console.log(`Response received from ${PROVIDER_ID}`);

    // Usage accounting (normalized)
    const usage = response.usage;
    if (usage) {
      const tokensUsed = usage.total_tokens || 0;
      console.log(`📊 Token Usage This Turn → Total: ${tokensUsed}`);
      step.tokensUsed = tokensUsed;
      recordTokenUsage(turnTimestamps, tokensUsed);
      ({ turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(turnTimestamps));
      console.log(`📈 Running Total Tokens Used (Rolling 60s): ${totalTokensUsed}`);
      step.totalTokensUsed = totalTokensUsed;
    }
    
    const msg = response.message ?? { role: 'assistant', content: '' };

    const planPlain  = summarizeTurnIntentFromMessage(msg, { emoji: true });
    const planDisplay = summarizeTurnIntentFromMessage(msg, {});
    step.summary = planPlain;
    step.events.unshift(`📝 Plan: ${planDisplay}`);
    console.log(`📝 Plan: ${planDisplay}`);

    if (msg.tool_calls?.length) {
      console.log('Processing tool calls...');
      const toolResponses = [];
      let lastToolName = null;

      for (const call of msg.tool_calls) {
        const fnName = call.function.name;
        lastToolName = fnName;
        const args = JSON.parse(call.function.arguments || '{}');
        const safeArgs = redactArgs(fnName, args);
        console.log(`[model] → ${fnName}`, safeArgs);
        step.events.push(`[model] → ${fnName} ${safeArgs}`);

        let result;
        let errorMessage = null;
        try {
          result = await CHROME_TOOL_MAP[fnName](browser, args, /*agentMemory*/ { lastMenuExpanded: false });
          if (typeof result !== 'string') result = JSON.stringify(result ?? '');
        } catch (e) {
          errorMessage = `ERROR: ${e.message}`;
          result = errorMessage;
        }

        // file event capture (unchanged)
        try {
          const maybeJson = JSON.parse(result);
          if (maybeJson && maybeJson._testronaut_file_event) {
            step.files = step.files || [];
            step.files.push(maybeJson);
            if (maybeJson._testronaut_file_event === 'upload') {
              const msgLine = `📤 Uploaded "${maybeJson.fileName}" (${formatBytes(maybeJson.bytes)}) via ${maybeJson.method}`;
              step.events.push(msgLine); console.log(msgLine);
            } else if (maybeJson._testronaut_file_event === 'download') {
              const msgLine = `📥 Downloaded "${maybeJson.fileName}" (${formatBytes(maybeJson.bytes)}) via ${maybeJson.mode}`;
              step.events.push(msgLine); console.log(msgLine);
            }
          }
        } catch { /* ignore */ }

        console.log(`[tool ] ← ${fnName} result:`, errorMessage ? '❌ Failed' : '✅ Success');
        step.events.push(`[tool ] ← ${fnName} result: ${errorMessage ? '❌ Failed' : '✅ Success'}`);
        const truncated = result.length > 100 ? result.slice(0, 100) + '…' : result;
        console.log(`[tool ] ← ${truncated}`);
        step.events.push(`[tool ] ← ${truncated}`);

        if (fnName === 'screenshot') {
          const match = result.match(/screenshot.*?saved at: (.+\.png)/i);
          if (match && match[1]) {
            step.screenshotPath = match[1];
            step.events.push(`🖼️ Screenshot captured: ${match[1]}`);
          }
        }
        
        toolResponses.push({
          role: 'tool',
          tool_call_id: call.id,
          name: fnName,
          type: 'function',
          content: result,
        });

        if (['click_text', 'click', 'expand_menu'].includes(fnName)) {
          console.log(`[auto] → Injecting DOM after ${fnName}...`);
          step.events.push(`[auto] → Injecting DOM after ${fnName}...`);
          const domHtml = await CHROME_TOOL_MAP.get_dom(browser, { limit: 100000, exclude: true, focus: [] }, { lastMenuExpanded: fnName === 'expand_menu' });
          await tokenEstimate(MODEL_ID, domHtml);
          await pushDOMAssistant(browser, messages, { lastMenuExpanded: fnName === 'expand_menu' }, { skipIfLastTool: ['get_dom', 'check_text'] });
          console.log(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`);
          step.events.push(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`);
        }
      }

      messages.push(msg, ...toolResponses);
      step.result = '✅ Passed';
      steps.push(step);
      continue;
    }

    const finalResponse = finalResponseHandler(msg);
    if (finalResponse !== null) {
      step.events.push(finalResponse.finalMessage);
      step.result = finalResponse.success ? '✅ Mission Success' : '❌ Mission Failure';
      steps.push(step);
      return { success: finalResponse.finalMessage, steps };
    }

    await pushDOMAssistant(browser, messages, { lastMenuExpanded: false }, { skipIfLastTool: ['get_dom', 'check_text'] });
    console.log(`[auto] → Injected DOM for next reasoning step`);
    step.events.push(`[auto] → Injected DOM for next reasoning step`);
  }
};
