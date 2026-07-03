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
import { maskPreview, redactArgs } from './redaction.js';
import { 
  sanitizeHeavyToolHistory, 
  pruneConversationContext,
  createEmptyGroundControl,
  applyGroundControlUpdate,
  recordGroundTelemetry,
 } from '../tools/contextControl.js';

// ─────────────────────────────────────────────
// STEP 0: Resolve provider + model and initialize adapter
// ─────────────────────────────────────────────
const { provider: PROVIDER_ID, model: MODEL_ID } = resolveProviderModel();
console.log(`🧠 Using LLM → provider: ${PROVIDER_ID}, model: ${MODEL_ID}`);

const llm = getLLM(PROVIDER_ID);

// Track resource/download coverage across turns (guard against partial loops).
function ensureDocProgress(agentMemory, cfg) {
  if (!cfg?.enabled) return null;
  if (!agentMemory.docProgress) {
    agentMemory.docProgress = {
      items: [],
      downloaded: new Set(),
      lastSummary: '',
      lastScriptCount: 0,
      patterns: cfg,
    };
  } else {
    agentMemory.docProgress.patterns = cfg;
  }
  return agentMemory.docProgress;
}

// Parse injected <pre data-testronaut-doc-list> summary into structured items.
function parseDocListFromDom(html) {
  try {
    const match = html.match(/<pre[^>]*data-testronaut-doc-list[^>]*>([\s\S]*?)<\/pre>/i);
    if (!match) return { items: [], scriptDocs: 0 };
    const text = match[1];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(1);
    const items = lines.map(l => {
      const m = l.match(/-\s*\[(.*?)\]\s*(.*?)\s+(\/document\/\d+[^\s]*)?/i);
      return {
        id: m?.[1] || '',
        title: m?.[2] || l.replace(/^-/, '').trim(),
        href: m?.[3] || '',
      };
    }).filter(it => it.id || it.title || it.href);
    return { items, scriptDocs: items.length };
  } catch {
    return { items: [], scriptDocs: 0 };
  }
}

// Extract numeric document IDs from common /document/<id> URLs.
function extractDocIdFromUrl(url = '') {
  const m = url.match(/\/document\/(\d+)/i);
  return m ? m[1] : '';
}

function isMfaLikeFill(fnName, args = {}) {
  if (fnName !== 'fill') return false;
  const haystack = [
    args.selector,
    args.label,
    args.placeholder,
    args.name,
    args.testId,
    args.role,
  ].map(v => String(v || '').toLowerCase()).join(' ');

  return /\b(mfa|totp|otp|verification|2fa|code)\b/.test(haystack);
}

function getFillText(args = {}) {
  return String(args.text ?? args.value ?? args.input ?? args.keys ?? '');
}

function safeListLabel(list = []) {
  return Array.isArray(list) && list.length ? list.join(', ') : '(none)';
}

// Rolling token counters used for self-throttling
let totalTokensUsed = 0;
let turnTimestamps = [];
let shouldBackoff;
const DEFAULT_TURN_RETRY_LIMIT = 2; // number of retries (not counting initial attempt)
const TURN_RETRY_BASE_DELAY_MS = 500;

// Certain tools mutate the browser or produce side effects that are
// *useful for humans* (reports/screenshots), but do not carry semantic
// information that the LLM needs on subsequent turns.
// For these, we respond to the tool_call with a tiny stub ("OK"/error)
// instead of the full result payload to avoid bloating context.
//
// NOTE: We *still* log the full result in `step.events` and step metadata.
const FIRE_AND_FORGET_TOOLS = new Set([
  'screenshot',
  'click',
  'click_text',
  // 'expand_menu',
  'fill',
  'upload_file',
  'download_file',
  'click_and_follow_popup',
  'switch_to_page',
  'close_current_page',
  'request_human_input',
]);

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
  ctx = {} // { steps, missionName, groundControl }
) => {
  const { steps = [], missionName, groundControl = createEmptyGroundControl(), retryLimit: retryLimitRaw } = ctx;
  const resourceGuardCfg = ctx.resourceGuard || {
    enabled: true,
    hrefIncludes: ['/document/', '/file/', '/download', '/attachment/'],
    dataTypes: ['document', 'file', 'item', 'row'],
  };
  const stepsArchive = ctx.stepsArchive || steps;
  const retryLimitClamped = Math.min(10, Math.max(1, Number.isFinite(retryLimitRaw) ? retryLimitRaw : DEFAULT_TURN_RETRY_LIMIT)); // retries allowed (excludes initial)
  const maxAttempts = retryLimitClamped + 1; // includes initial attempt
  ctx.groundControl = groundControl;
  const humanInput = ctx.humanInput || { enabled: true, timeoutSeconds: 60 };
  const activeToolsSchema = humanInput.enabled === false
    ? toolsSchema.filter(t => t?.function?.name !== 'request_human_input')
    : toolsSchema;
  let agentMemory = { lastMenuExpanded: false, humanInput };
  ensureDocProgress(agentMemory, resourceGuardCfg);
  let turnRetries = 0;
  let stepSeq = ctx._stepSeq || 0;
  
  // Centralized recorder: push to in-memory buffer AND fire optional callback for streaming
  // Idempotent recorder – prevents accidental double-push
  const recordStep = (step) => {
    if (!step || step.__recorded) return;
    step._seq = stepSeq++;
    step.__recorded = true;
    try { steps.push(step); } catch {}
    if (stepsArchive && stepsArchive !== steps) {
      try { stepsArchive.push(step); } catch {}
    }
    try { ctx?.onStep?.(step); } catch {}
  };
  
  // ─────────────────────────────────────────────
  // STEP 1: Begin reasoning cycle
  // ─────────────────────────────────────────────
  for (let turn = currentTurn; turn < maxTurns; turn++) {
    console.log(`\n🔄 Turn ${turn + 1}/${maxTurns}`);
    let response;
    const attempt = turnRetries + 1;
    const step = {
      turn,
      retryAttempt: attempt,
      retryLimit: retryLimitClamped, // number of retries allowed (excludes initial)
      events: [],
      result: '🟡 In Progress',
      missionName,
    };
    if (attempt > 1) {
      const retryNumber = attempt - 1;
      step.events.push(`🔁 Re-attempt ${retryNumber}/${retryLimitClamped} for turn`);
    }

    try {
      // Refresh token usage window (rolling 60 seconds)
      ({ turnTimestamps, totalTokensUsed } = pruneOldTokenUsage(turnTimestamps));

      // Adaptive cooldown if nearing provider rate limit
      ({ totalTokensUsed, turnTimestamps, shouldBackoff } =
        await tokenUseCoolOff(totalTokensUsed, turnTimestamps, MODEL_ID));
      if (shouldBackoff) {
        recordStep(step);         // ✅ write the partial step before sleeping
        turn -= 1;                // retry same turn index
        continue;
      }

      // Verify message structure integrity before requesting next model step
      if (!validateAndInsertMissingToolResponses(messages, { insertPlaceholders: true })) {
        console.error('❌ Tool call structure invalid and no placeholders inserted.');
        step.events.push('❌ Tool call structure invalid and no placeholders inserted.');
        step.result = '❌ Failure';
        recordStep(step);
        return { success: false, steps: stepsArchive };
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
        return { success: false, steps: stepsArchive };
      }

      // Before calling the model, trim/sanitize the conversation context.
      // 1) Replace older heavy tool payloads with small stubs.
      sanitizeHeavyToolHistory(messages, { keepRecentPerTool: 2 });

      // 2) Hard-cap total history length (system messages + last N others).
      {
        const pruned = pruneConversationContext(messages, { maxNonSystemMessages: 40 });
        messages.length = 0;
        messages.push(...pruned);
      }


      // ─────────────────────────────────────────────
      // STEP 2: Request next reasoning turn from model
      // ─────────────────────────────────────────────
      const { message, usage, headers } = await llm.chat({
        model: MODEL_ID,
        messages,
        tools: activeToolsSchema,
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
        recordStep(step);         // ✅ persist this step before sleeping
        await wait(delay);

        if (retryCount >= 5) {
          console.error('❌ Too many retries. Exiting.');
          step.events.push('❌ Too many retries. Exiting.');
          step.result = '❌ Failure';
          recordStep(step);
          return { success: false, steps: stepsArchive };
        }
        retryCount += 1;
        turn -= 1;
        continue;
      } else if (err.status === 400) {
        console.error('❌ Bad request:', err.message);
        step.events.push(`❌ Bad request: ${err.message}`);
        step.result = '❌ Failure';
        recordStep(step);
        return { success: false, steps: stepsArchive };
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
      let hadToolIssues = false;

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
          hadToolIssues = true;
        }

        if (fnName === 'request_human_input') {
          step.humanInput = step.humanInput || {};
          step.humanInput.requested = true;
          step.humanInput.codeType = args.codeType || 'verification_code';
          step.humanInput.timeoutSeconds = humanInput.timeoutSeconds;
          step.humanInput.status = errorMessage
            ? (String(errorMessage).toLowerCase().includes('timed out') ? 'timeout' : 'invalid')
            : 'provided';
          step.events.push(errorMessage
            ? `👤 Human-in-the-loop input ${step.humanInput.status}: ${errorMessage.replace(/^ERROR:\s*/, '')}`
            : '👤 Human-in-the-loop input provided.');

          if (!errorMessage) {
            try {
              const parsed = JSON.parse(result);
              agentMemory.lastVerificationInput = {
                source: 'human_input',
                value: parsed.value,
                codeType: parsed.codeType || args.codeType || 'verification_code',
              };
            } catch {
              // ignore malformed tool result
            }
          }
        }

        if (fnName === 'get_mfa_code') {
          step.mfa = step.mfa || {};
          step.mfa.requested = true;
          try {
            const parsed = JSON.parse(result);
            step.mfa.nickname = parsed.nickname || args.nickname || null;
            step.mfa.status = parsed.ok ? 'provided' : parsed.code || 'unavailable';
            step.mfa.availableNicknames = parsed.availableNicknames || [];
            step.mfa.responseKeys = parsed.responseKeys || [];
            step.mfa.listStatus = parsed.mfaListStatus || null;
            agentMemory.lastMfaLookup = parsed.ok
              ? {
                  ok: true,
                  nickname: parsed.nickname || args.nickname || null,
                  value: parsed.value,
                  secondsRemaining: parsed.mfaCode?.secondsRemaining,
                  resolvedFromList: !!parsed.resolvedFromList,
                  requestedNickname: parsed.requestedNickname,
                  availableNicknames: parsed.availableNicknames || [],
                }
              : {
                  ok: false,
                  nickname: parsed.nickname || args.nickname || null,
                  code: parsed.code,
                  error: parsed.error,
                  availableNicknames: parsed.availableNicknames || [],
                  responseKeys: parsed.responseKeys || [],
                  mfaListStatus: parsed.mfaListStatus || null,
                };

            step.events.push(
              parsed.ok
                ? `🔐 MFA code retrieved for "${step.mfa.nickname || 'configured MFA'}".`
                : `🔐 MFA code unavailable: ${parsed.error || parsed.code || 'unknown error'}`
            );
            if (parsed.ok) {
              const detailLine = [
                `🔐 MFA source: API`,
                `nickname="${step.mfa.nickname || 'configured MFA'}"`,
                parsed.resolvedFromList ? `resolvedFromList=true` : null,
                Number.isFinite(parsed.mfaCode?.secondsRemaining)
                  ? `secondsRemaining=${parsed.mfaCode.secondsRemaining}`
                  : null,
              ].filter(Boolean).join(' ');
              console.log(detailLine);
              step.events.push(detailLine);
            } else {
              const reasonLine = `🔐 MFA unavailable reason: ${parsed.code || 'unknown'} - ${parsed.error || 'unknown error'}`;
              console.log(reasonLine);
              step.events.push(reasonLine);

              if (Array.isArray(parsed.availableNicknames)) {
                const listLine = `🔐 MFA list endpoint nicknames: ${safeListLabel(parsed.availableNicknames)}`;
                console.log(listLine);
                step.events.push(listLine);
              }

              if (parsed.mfaListStatus && parsed.mfaListStatus !== 'available') {
                const listStatusLine = `🔐 MFA list endpoint status: ${JSON.stringify(parsed.mfaListStatus)}`;
                console.log(listStatusLine);
                step.events.push(listStatusLine);
              } else if (parsed.mfaListStatus === 'available') {
                const listStatusLine = '🔐 MFA list endpoint status: available';
                console.log(listStatusLine);
                step.events.push(listStatusLine);
              }

              if (Array.isArray(parsed.responseKeys) && parsed.responseKeys.length) {
                const keysLine = `🔐 MFA API response keys: ${parsed.responseKeys.join(', ')}`;
                console.log(keysLine);
                step.events.push(keysLine);
              }
            }
          } catch {
            step.mfa.status = errorMessage ? 'error' : 'unknown';
          }
        }

        // Capture and log any file upload/download events (for reports)
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

            if (resourceGuardCfg.enabled && (maybeJson._testronaut_file_event === 'download' || maybeJson._testronaut_file_event === 'upload')) {
              const prog = ensureDocProgress(agentMemory, resourceGuardCfg);
              if (prog) {
                const id = extractDocIdFromUrl(maybeJson.url || maybeJson.selector || maybeJson.fileName);
                if (id) prog.downloaded.add(id);
                // also try title match
                if (maybeJson.fileName) {
                  const byTitle = prog.items.find(i => maybeJson.fileName.includes(i.title));
                  if (byTitle?.id) prog.downloaded.add(byTitle.id);
                }
                step.events.push(`📊 Resource progress: ${prog.downloaded.size}/${prog.items.length || prog.lastScriptCount}`);
              }
            }
          }
        } catch {
          // non-JSON results ignored
        }

        let toolStatusLabel = errorMessage ? '❌ Failed' : '✅ Success';
        if (fnName === 'get_mfa_code' && !errorMessage) {
          try {
            const parsed = JSON.parse(result);
            toolStatusLabel = parsed.ok
              ? '✅ Code retrieved'
              : `⚠️ Unavailable${parsed.code ? ` (${parsed.code})` : ''}`;
          } catch {
            toolStatusLabel = '⚠️ Unavailable';
          }
        }

        console.log(`[tool ] ← ${fnName} result:`, toolStatusLabel);

        if (isMfaLikeFill(fnName, args)) {
          const fillText = getFillText(args);
          let sourceLine;
          if (agentMemory.lastMfaLookup?.ok && fillText === agentMemory.lastMfaLookup.value) {
            sourceLine = `🔐 MFA fill source: get_mfa_code nickname="${agentMemory.lastMfaLookup.nickname || 'configured MFA'}"`;
          } else if (agentMemory.lastVerificationInput?.value && fillText === agentMemory.lastVerificationInput.value) {
            sourceLine = `🔐 MFA fill source: request_human_input codeType="${agentMemory.lastVerificationInput.codeType}"`;
          } else if (agentMemory.lastMfaLookup && !agentMemory.lastMfaLookup.ok) {
            sourceLine = `⚠️ MFA fill source: not from get_mfa_code. Last MFA lookup failed with ${agentMemory.lastMfaLookup.code || 'unknown'}: ${agentMemory.lastMfaLookup.error || 'unknown error'}`;
          } else {
            sourceLine = '⚠️ MFA fill source: not from a recorded get_mfa_code or request_human_input result.';
          }
          console.log(sourceLine);
          step.events.push(sourceLine);
        }

        let resultForLog = result;
        if (fnName === 'request_human_input') {
          try {
            const parsed = JSON.parse(result);
            resultForLog = JSON.stringify({
              ...parsed,
              value: maskPreview(parsed.value),
              redactedValue: maskPreview(parsed.value),
            });
          } catch {
            resultForLog = errorMessage || 'Human input received.';
          }
        }
        if (fnName === 'get_mfa_code') {
          try {
            const parsed = JSON.parse(result);
            resultForLog = JSON.stringify({
              ...parsed,
              value: maskPreview(parsed.value),
              redactedValue: maskPreview(parsed.value),
              mfaCode: parsed.mfaCode
                ? {
                    ...parsed.mfaCode,
                    code: maskPreview(parsed.mfaCode.code),
                  }
                : parsed.mfaCode,
            });
          } catch {
            resultForLog = errorMessage || 'MFA code lookup completed.';
          }
        }
        const truncated = resultForLog.length > 1000 ? resultForLog.slice(0, 1000) + '…' : resultForLog;
        step.events.push(`[tool ] ← ${fnName} result: ${toolStatusLabel}`);
        step.events.push(`[tool ] ← ${truncated}`);

        // Screenshot detection (for report metadata only)
        if (fnName === 'screenshot') {
          const match = result.match(/screenshot.*?saved at: (.+\.png)/i);
          if (match && match[1]) {
            step.screenshotPath = match[1];
            step.events.push(`🖼️ Screenshot captured: ${match[1]}`);
          }
        }

        if (fnName === 'set_ground_control_state') {
          applyGroundControlUpdate(groundControl, args);
          result = JSON.stringify({ ok: true, groundControl });
        }

        if (fnName === 'record_mission_telemetry') {
          const recorded = recordGroundTelemetry(groundControl, args, { turn });
          result = JSON.stringify({ ok: true, recorded });
        }

        // Decide what to send back to the LLM for this tool.
        // - For "fire-and-forget" tools, send a tiny stub (OK/error) to avoid
        //   bloating context with large payloads (file JSON, etc.).
        // - For semantic tools (get_dom, check_text, etc.), send full result.
        let contentForModel;
        if (FIRE_AND_FORGET_TOOLS.has(fnName)) {
          contentForModel = errorMessage || 'OK';
        } else {
          contentForModel = result;
        }

        // Keep doc list progress updated when we fetch DOM
        if (!errorMessage && resourceGuardCfg.enabled) {
          const prog = ensureDocProgress(agentMemory, resourceGuardCfg);
          if (prog) {
            if (fnName === 'get_dom') {
              const { items, scriptDocs } = parseDocListFromDom(result);
              if (items.length) {
                prog.items = items;
                prog.lastScriptCount = scriptDocs || items.length;
                prog.lastSummary = `docs:${items.length}`;
                step.events.push(`📊 Detected document list (${items.length} items)`);
              }
            } else if (fnName === 'list_local_files') {
              try {
                const parsed = JSON.parse(result);
                const files = parsed?.files || [];
                if (Array.isArray(files) && files.length) {
                  prog.items = files.map(f => ({ id: f, title: f, href: f }));
                  prog.lastScriptCount = files.length;
                  prog.lastSummary = `files:${files.length}`;
                  step.events.push(`📊 Detected local files (${files.length} items)`);
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }

        toolResponses.push({
          role: 'tool',
          tool_call_id: call.id,
          name: fnName,
          type: 'function',
          content: contentForModel,
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
      if (hadToolIssues && turnRetries < retryLimitClamped) {
        step.result = '⏳ Retrying turn';
        const retryNumber = attempt - 1;
        step.events.push(`🔁 Re-attempt ${retryNumber}/${retryLimitClamped} after tool issues`);
        recordStep(step);
        turnRetries += 1;
        const delay = Math.min(TURN_RETRY_BASE_DELAY_MS * 2 ** (turnRetries - 1), 2000);
        await wait(delay);
        turn -= 1; // re-use the same turn index
        continue;
      }

      // reset retries after a clean turn or after exhausting retries
      turnRetries = 0;
      step.result = hadToolIssues ? '⚠️ Turn Issues' : '✅ Passed';
      recordStep(step);
      continue;
    }

    // ─────────────────────────────────────────────
    // STEP 6: Detect final mission state
    // ─────────────────────────────────────────────
    const finalResponse = finalResponseHandler(msg);
    if (finalResponse !== null) {
      const prog = ensureDocProgress(agentMemory, resourceGuardCfg);
      if (prog?.items.length && prog.downloaded.size < prog.items.length) {
        const remaining = prog.items
          .filter(i => !prog.downloaded.has(i.id))
          .map(i => i.title || i.id)
          .slice(0, 10);
        const remainText = remaining.length ? remaining.join('; ') : 'unknown items';
        const guardMsg = `Auto-guard: downloaded ${prog.downloaded.size}/${prog.items.length}. Remaining: ${remainText}`;
        console.log(`[guard] ${guardMsg}`);
        step.events.push(guardMsg);
        step.result = '🟡 In Progress';
        recordStep(step);
        // Nudge model to continue
        messages.push({ role: 'assistant', content: guardMsg });
        // Continue loop without exiting
        turnRetries = 0;
        continue;
      }
      step.events.push(finalResponse.finalMessage);
      step.result = finalResponse.success ? '✅ Mission Success' : '❌ Mission Failure';
      recordStep(step);
      turnRetries = 0;
      return { success: finalResponse.success, finalMessage: finalResponse.finalMessage, steps: stepsArchive };
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
    turnRetries = 0;
  }

  return { success: false, steps: stepsArchive };
};

// Expose small helper bundle for unit tests (no production use).
export const __docProgressInternals = {
  ensureDocProgress,
  parseDocListFromDom,
  extractDocIdFromUrl,
};
