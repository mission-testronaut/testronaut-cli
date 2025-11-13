/**
 * turnLoop.js
 * ------------
 * Purpose:
 *   Core execution loop for Testronaut's autonomous agent testing framework.
 *   Handles reasoning turns, model responses, tool execution, DOM updates,
 *   backoff logic, and final mission success/failure detection.
 *
 * Responsibilities:
 *   - Coordinate between browser (Playwright/Puppeteer) and chosen LLM.
 *   - Maintain conversation history and agent "memory" between turns.
 *   - Detect and execute tool/function calls emitted by the model.
 *   - Track and enforce token-per-minute rate limits with adaptive cooldowns.
 *   - Handle DOM re-injection after browser actions to support reasoning continuity.
 *   - Summarize each turn’s intent and record detailed step logs.
 *
 * Related tests:
 *   Located in `tests/coreTests/`
 *   (see integration tests covering multi-turn reasoning, tool calling, and backoff).
 *
 * Used by:
 *   - CLI mission runners (`missionRunner.js`, `runMission.js`)
 *   - Autonomous agent framework during mission playback.
 *
 * Notes:
 *   - Provider-agnostic: routes all LLM calls through the `llmFactory` adapter layer.
 *   - OpenAI and Gemini both normalize responses to an OpenAI-like message format.
 *   - Token control is model-sensitive but provider-neutral.
 */

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
  updateLimitsFromHeaders
} from '../tools/tokenControl.js';
import { resolveProviderModel } from '../llm/modelResolver.js';
import { getLLM } from '../llm/llmFactory.js';
import { summarizeTurnIntentFromMessage } from './turnIntent.js';
import { redactArgs } from './redaction.js';

// ─────────────────────────────────────────────
// STEP 0: Resolve provider + model and initialize adapter
// ─────────────────────────────────────────────
const { provider: PROVIDER_ID, model: MODEL_ID } = resolveProviderModel();
console.log(`🧠 Using LLM → provider: ${PROVIDER_ID}, model: ${MODEL_ID}`);

const llm = getLLM(PROVIDER_ID);

// Rolling token counters used for self-throttling
let totalTokensUsed = 0;
let turnTimestamps = [];
let shouldBackoff;
// let steps = [];

/**
 * Utility: format byte counts into human-readable strings.
 * Used when reporting upload/download events in mission logs.
 */
function formatBytes(n) {
  if (!Number.isFinite(n)) return `${n}`;
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Pushes a new "get_dom" tool call and result pair into the message history.
 * This keeps the model updated on the browser's DOM after actions like click/expand.
 *
 * @param {object} browser - The browser automation instance.
 * @param {array} messages - The running conversation message array.
 * @param {object} agentMemory - Memory object storing recent agent state.
 * @param {{skipIfLastTool?: string[]}} opts - Optional tool skip conditions.
 */
const pushDOMAssistant = async (browser, messages, agentMemory, { skipIfLastTool } = {}) => {
  // Avoid redundant DOM pushes immediately following tools that already include DOM context.
  if (skipIfLastTool && skipIfLastTool.includes(messages.at(-1)?.name)) {
    console.log(`[skip] Skipping DOM push after redundant tool: ${messages.at(-1)?.name}`);
    return;
  }

  const domCallId = `get_dom_${Date.now()}`;

  // Inject a synthetic assistant tool call
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

  // Push the corresponding tool response back into the conversation
  messages.push({
    role: 'tool',
    tool_call_id: domCallId,
    name: 'get_dom',
    type: 'function',
    content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
  });
};

/**
 * Main turn loop driver.
 *
 * Runs the agent through iterative reasoning turns until:
 * - Max turn count is reached, or
 * - The model emits a "final" message (success/failure).
 *
 * @param {object} browser - Browser automation interface (Playwright/Puppeteer).
 * @param {array} messages - Conversation messages so far.
 * @param {number} maxTurns - Maximum allowed reasoning turns.
 * @param {number} currentTurn - Turn index to start from (default 0).
 * @param {number} retryCount - Internal retry counter for rate limiting.
 * @param {object} currentStep - Step data being populated for the current turn.
 * @param {object} ctx - Shared context (steps array, mission name).
 * @returns {Promise<object[]>} - Collected step results or final success message.
 */
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
  
  // Centralized recorder: push to in-memory buffer AND fire optional callback for streaming
  // Idempotent recorder – prevents accidental double-push
  const recordStep = (step) => {
    if (!step || step.__recorded) return;
    step.__recorded = true;
    try { steps.push(step); } catch {}
    try { ctx?.onStep?.(step); } catch {}
  };
  
  // ─────────────────────────────────────────────
  // STEP 1: Begin reasoning cycle
  // ─────────────────────────────────────────────
  for (let turn = currentTurn; turn < maxTurns; turn++) {
    console.log(`\n🔄 Turn ${turn + 1}/${maxTurns}`);
    let response;
    const step = { turn, events: [], result: '🟡 In Progress', missionName };

    try {
      // Refresh token usage window (rolling 60 seconds)
      ({ turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(turnTimestamps));

      // Adaptive cooldown if nearing provider rate limit
      ({ totalTokensUsed, turnTimestamps, shouldBackoff } =
        await tokenUseCoolOff(totalTokensUsed, turnTimestamps, MODEL_ID));
      if (shouldBackoff) {
        // step.result = '🟡 In Progress';
        recordStep(step);         // ✅ write the partial step before sleeping
        turn -= 1;                // retry same turn index
        continue;
        // return await turnLoop(browser, messages, maxTurns, turn, currentStep);
      }

      // Verify message structure integrity before requesting next model step
      if (!validateAndInsertMissingToolResponses(messages, { insertPlaceholders: true })) {
        console.error('❌ Tool call structure invalid and no placeholders inserted.');
        step.events.push('❌ Tool call structure invalid and no placeholders inserted.');
        step.result = '❌ Failure';
        recordStep(step);
        return steps;
      }

      // Detect orphaned assistant tool calls with no matching tool responses
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
        recordStep(step);
        return steps;
      }

      // ─────────────────────────────────────────────
      // STEP 2: Request next reasoning turn from model
      // ─────────────────────────────────────────────
      const { message, usage, headers } = await llm.chat({
        model: MODEL_ID,
        messages,
        tools: toolsSchema,
      });
      response = { message, usage, headers };

    } catch (err) {
      // ─────────────────────────────────────────────
      // STEP 3: Error and rate-limit handling
      // ─────────────────────────────────────────────
      if (err.status === 429) {
        try { updateLimitsFromHeaders(MODEL_ID, err.headers || err.response?.headers || {}); } catch {}
        const delay = Math.min(60000, 2 ** retryCount * 2000);
        console.warn(`⚠️ Rate limited. Retrying in ${delay / 1000}s... (retry ${retryCount + 1})`);
        step.events.push(`⏳ Rate limit: waiting ${Math.round(delay/1000)}s (retry ${retryCount + 1})`);
        // step.result = '🟡 In Progress';
        recordStep(step);         // ✅ persist this step before sleeping
        await wait(delay);

        if (retryCount >= 5) {
          console.error('❌ Too many retries. Exiting.');
          step.events.push('❌ Too many retries. Exiting.');
          step.result = '❌ Failure';
          recordStep(step);
          return steps;
        }
        // return await turnLoop(browser, messages, maxTurns, turn, retryCount + 1, step);
        // reattempt same turn after delay; keep same loop, bump retryCount
        retryCount += 1;
        turn -= 1;
        continue;
      } else if (err.status === 400) {
        console.error('❌ Bad request:', err.message);
        step.events.push(`❌ Bad request: ${err.message}`);
        step.result = '❌ Failure';
        recordStep(step);
        return steps;
      } else {
        throw err;
      }
    }

    // ─────────────────────────────────────────────
    // STEP 4: Process model response
    // ─────────────────────────────────────────────
    console.log(`Response received from ${PROVIDER_ID}`);
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

    // Summarize model’s plan for the turn (plain + emoji variants)
    const planPlain = summarizeTurnIntentFromMessage(msg, { emoji: true });
    const planDisplay = summarizeTurnIntentFromMessage(msg);
    step.summary = planPlain;
    step.events.unshift(`📝 Plan: ${planDisplay}`);
    console.log(`📝 Plan: ${planDisplay}`);

    // ─────────────────────────────────────────────
    // STEP 5: Handle tool/function calls
    // ─────────────────────────────────────────────
    if (msg.tool_calls?.length) {
      console.log('Processing tool calls...');
      const toolResponses = [];

      for (const call of msg.tool_calls) {
        const fnName = call.function.name;
        const args = JSON.parse(call.function.arguments || '{}');
        const safeArgs = redactArgs(fnName, args);
        console.log(`[model] → ${fnName}`, safeArgs);
        step.events.push(`[model] → ${fnName} ${safeArgs}`);

        let result;
        let errorMessage = null;
        try {
          result = await CHROME_TOOL_MAP[fnName](browser, args, agentMemory);
          if (typeof result !== 'string') result = JSON.stringify(result ?? '');
        } catch (e) {
          errorMessage = `ERROR: ${e.message}`;
          result = errorMessage;
        }

        // Capture and log any file upload/download events
        try {
          const maybeJson = JSON.parse(result);
          if (maybeJson && maybeJson._testronaut_file_event) {
            step.files = step.files || [];
            step.files.push(maybeJson);
            const msgLine = maybeJson._testronaut_file_event === 'upload'
              ? `📤 Uploaded "${maybeJson.fileName}" (${formatBytes(maybeJson.bytes)}) via ${maybeJson.method}`
              : `📥 Downloaded "${maybeJson.fileName}" (${formatBytes(maybeJson.bytes)}) via ${maybeJson.mode}`;
            step.events.push(msgLine);
            console.log(msgLine);
          }
        } catch { /* non-JSON results ignored */ }

        console.log(`[tool ] ← ${fnName} result:`, errorMessage ? '❌ Failed' : '✅ Success');
        const truncated = result.length > 1000 ? result.slice(0, 1000) + '…' : result;
        step.events.push(`[tool ] ← ${fnName} result: ${errorMessage ? '❌ Failed' : '✅ Success'}`);
        step.events.push(`[tool ] ← ${truncated}`);

        // Screenshot detection
        if (fnName === 'screenshot') {
          const match = result.match(/screenshot.*?saved at: (.+\.png)/i);
          if (match && match[1]) {
            step.screenshotPath = match[1];
            step.events.push(`🖼️ Screenshot captured: ${match[1]}`);
          }
        }

        // Push corresponding tool message back to LLM
        toolResponses.push({
          role: 'tool',
          tool_call_id: call.id,
          name: fnName,
          type: 'function',
          content: result,
        });

        // After interactive DOM actions, refresh model context
        if (['click_text', 'click', 'expand_menu'].includes(fnName)) {
          console.log(`[auto] → Injecting DOM after ${fnName}...`);
          step.events.push(`[auto] → Injecting DOM after ${fnName}...`);
          const domHtml = await CHROME_TOOL_MAP.get_dom(browser, {
            limit: 100000,
            exclude: true,
            focus: [],
          }, agentMemory);
          await tokenEstimate(MODEL_ID, domHtml);
          await pushDOMAssistant(browser, messages, agentMemory, {
            skipIfLastTool: ['get_dom', 'check_text'],
          });
          console.log(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`);
          step.events.push(`[auto] → DOM size after ${fnName}: ${domHtml.length} chars`);
        }
      }

      // Merge new assistant + tool responses back into conversation
      messages.push(msg, ...toolResponses);
      step.result = '✅ Passed';
      recordStep(step);
      continue;
    }

    // ─────────────────────────────────────────────
    // STEP 6: Detect final mission state
    // ─────────────────────────────────────────────
    const finalResponse = finalResponseHandler(msg);
    if (finalResponse !== null) {
      step.events.push(finalResponse.finalMessage);
      step.result = finalResponse.success ? '✅ Mission Success' : '❌ Mission Failure';
      recordStep(step);
      return { success: finalResponse.finalMessage, steps };
    }

    // ─────────────────────────────────────────────
    // STEP 7: Fallback → Push DOM for next reasoning cycle
    // ─────────────────────────────────────────────
    await pushDOMAssistant(browser, messages, agentMemory, {
      skipIfLastTool: ['get_dom', 'check_text'],
    });
    console.log(`[auto] → Injected DOM for next reasoning step`);
    step.events.push(`[auto] → Injected DOM for next reasoning step`);
    // This is a meaningful turn even without tool calls — record it.
    step.result = step.result || '🟡 In Progress';
    recordStep(step);
  }
};
