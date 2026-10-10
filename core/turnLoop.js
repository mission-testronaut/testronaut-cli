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
 *   - All providers normalize responses to an OpenAI-like message format.
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
  updateLimitsFromHeaders,
  updateLimitsFromError,
  configureTokenControl,
  warnIfContextNearLimit
} from '../tools/tokenControl.js';
import { resolveProviderModel } from '../llm/modelResolver.js';
import { getLLM } from '../llm/llmFactory.js';
import { summarizeTurnIntentFromMessage } from './turnIntent.js';
import { maskPreview, redactArgs, redactPasswordInText } from './redaction.js';
import { buildJevShadowState, buildJevStrategyQuestions, evaluateJevCompletionCandidate, evaluateJevShadow, extractJevStrategyResults, resolveJevShadowConfig, sanitizeJevShadowEvents } from './jevShadow.js';
import { buildBrowserEvidence, collectBrowserControlState, mergeBrowserControlState } from './browserEvidence.js';
import { chooseJevTurnModel, resolveJevRoutingConfig } from './jevRouting.js';
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

let rateLimitConfig;
try {
  const config = JSON.parse(fs.readFileSync('testronaut-config.json', 'utf8'));
  rateLimitConfig = config.rateLimits;
} catch { /* startup fallbacks remain active when config is absent or invalid */ }
configureTokenControl({ provider: PROVIDER_ID, rateLimits: rateLimitConfig });

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
  'set_ground_control_state',
  'record_mission_telemetry',
]);

function currentBrowserUrl(browser) {
  try { return browser?.page?.url?.() || null; } catch { return null; }
}

async function captureBrowserEvidence(browser, html, previous) {
  const evidence = buildBrowserEvidence(html, {
    url: currentBrowserUrl(browser),
    previous,
    redactText: redactPasswordInText,
  });
  const states = await collectBrowserControlState(browser);
  return mergeBrowserControlState(evidence, states);
}

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
const pushDOMAssistant = async (browser, messages, agentMemory, { skipIfLastTool, limit = 15000 } = {}) => {
  // Avoid redundant DOM pushes immediately following tools that already include DOM context.
  if (skipIfLastTool && skipIfLastTool.includes(messages.at(-1)?.name)) {
    console.log(`[skip] Skipping DOM push after redundant tool: ${messages.at(-1)?.name}`);
    return { injected: false, domLength: 0 };
  }

  const domCallId = `get_dom_${Date.now()}`;
  const automaticDomLimit = limit;

  // Inject a synthetic assistant tool call
  messages.push({
    role: 'assistant',
    tool_calls: [
      {
        id: domCallId,
        type: 'function',
        function: {
          name: 'get_dom',
          arguments: JSON.stringify({ limit: automaticDomLimit, exclude: true }),
        },
      },
    ],
  });

  const domHtml = await CHROME_TOOL_MAP.get_dom(
    browser,
    { limit: automaticDomLimit, exclude: true },
    agentMemory
  );
  await tokenEstimate(MODEL_ID, domHtml);
  agentMemory.browserEvidence = await captureBrowserEvidence(
    browser,
    domHtml,
    agentMemory.browserEvidence,
  );

  // Push the corresponding tool response back into the conversation
  messages.push({
    role: 'tool',
    tool_call_id: domCallId,
    name: 'get_dom',
    type: 'function',
    content: typeof domHtml === 'string' ? domHtml : JSON.stringify(domHtml),
  });

  return {
    injected: true,
    domLength: typeof domHtml === 'string' ? domHtml.length : JSON.stringify(domHtml).length,
  };
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
  const jevShadowConfig = resolveJevShadowConfig();
  const jevRoutingConfig = resolveJevRoutingConfig(process.env, {
    provider: PROVIDER_ID,
    primaryModel: MODEL_ID,
  });
  const retryLimitClamped = Math.min(10, Math.max(1, Number.isFinite(retryLimitRaw) ? retryLimitRaw : DEFAULT_TURN_RETRY_LIMIT)); // retries allowed (excludes initial)
  const maxAttempts = retryLimitClamped + 1; // includes initial attempt
  ctx.groundControl = groundControl;
  const humanInput = ctx.humanInput || { enabled: true, timeoutSeconds: 60 };
  const disabledTools = new Set();
  if (humanInput.enabled === false) disabledTools.add('request_human_input');
  if (process.env.TESTRONAUT_SCREENSHOTS === '0') disabledTools.add('screenshot');
  const activeToolsSchema = toolsSchema.filter(t => !disabledTools.has(t?.function?.name));
  let agentMemory = { lastMenuExpanded: false, humanInput };
  ensureDocProgress(agentMemory, resourceGuardCfg);
  let turnRetries = 0;
  let stepSeq = ctx._stepSeq || 0;
  let nextJevStrategy = null;
  let forcePrimaryRetry = false;

  const recordJevShadow = async (step, msg, phase, proposedTools = []) => {
    if (!jevShadowConfig.enabled) return;
    nextJevStrategy = null;
    // Keep status lines and purpose-built telemetry, but exclude raw tool payload
    // lines (which may contain DOM, page text, or other third-party data).
    const safeEvents = sanitizeJevShadowEvents(step.events, redactPasswordInText);
    agentMemory.browserEvidence = await captureBrowserEvidence(
      browser,
      null,
      agentMemory.browserEvidence,
    );
    const state = buildJevShadowState({
      mission: redactPasswordInText(ctx.goal || missionName),
      turn: step.turn,
      maxTurns,
      phase,
      assistantSummary: redactPasswordInText(step.summary || ''),
      assistantContent: redactPasswordInText(msg?.content || ''),
      proposedTools,
      events: safeEvents,
      groundControl,
      browserEvidence: agentMemory.browserEvidence,
    });
    const strategyCatalog = jevShadowConfig.strategiesEnabled
      ? buildJevStrategyQuestions(agentMemory.browserEvidence)
      : null;
    step.jevShadow = await evaluateJevShadow(state, {
      config: jevShadowConfig,
      ...(strategyCatalog ? { questions: strategyCatalog.questions } : {}),
    });
    if (step.jevShadow.status === 'ok' && strategyCatalog) {
      step.jevShadow.strategies = extractJevStrategyResults(
        step.jevShadow.answers,
        strategyCatalog,
      );
      nextJevStrategy = step.jevShadow.strategies;
    }
    step.jevShadow.completionGate = evaluateJevCompletionCandidate(step.jevShadow, {
      threshold: jevShadowConfig.gateThreshold,
      browserEvidence: agentMemory.browserEvidence,
    });
    const status = step.jevShadow?.status || 'unknown';
    const latency = Number.isFinite(step.jevShadow?.latencyMs)
      ? ` in ${step.jevShadow.latencyMs}ms`
      : '';
    console.log(`🔬 Jev shadow: ${status}${latency}`);
  };

  const finalizeWithJevGate = async (step) => {
    if (!jevShadowConfig.gateEnabled || !step.jevShadow?.completionGate?.candidate) return null;

    const prog = ensureDocProgress(agentMemory, resourceGuardCfg);
    if (prog?.items.length && prog.downloaded.size < prog.items.length) {
      step.jevGate = { triggered: false, reason: 'resource_guard_incomplete' };
      return null;
    }

    const existingScreenshot = Boolean(
      step.screenshotPath
        || steps.some(existing => existing?.screenshotPath)
        || stepsArchive.some(existing => existing?.screenshotPath),
    );
    if (process.env.TESTRONAUT_SCREENSHOTS !== '0' && !existingScreenshot) {
      try {
        const screenshotResult = await CHROME_TOOL_MAP.screenshot(
          browser,
          { name: `jev-completion-turn-${step.turn + 1}` },
          agentMemory,
        );
        const match = String(screenshotResult).match(/screenshot.*?saved at: (.+\.png)/i);
        if (match?.[1]) step.screenshotPath = match[1];
        step.events.push('🖼️ Jev completion gate captured final screenshot');
      } catch (error) {
        step.jevGate = { triggered: false, reason: 'screenshot_failed', error: error?.message || String(error) };
        step.events.push(`⚠️ Jev completion gate screenshot failed: ${error?.message || error}`);
        return null;
      }
    }

    const gate = step.jevShadow.completionGate;
    recordGroundTelemetry(groundControl, {
      kind: 'assertion',
      text: `Jev completion gate satisfied at ${Math.round(gate.threshold * 100)}% threshold.`,
      status: 'passed',
    }, { turn: step.turn, source: 'jev_completion_gate', signals: gate.signals });

    step.jevGate = { triggered: true, ...gate };
    step.events.push(`🔬 Jev completion gate triggered at ${Math.round(gate.threshold * 100)}% threshold`);
    step.result = '✅ Mission Success (Jev gate)';
    recordStep(step);
    const finalMessage = 'SUCCESS: Jev completion gate found sufficient browser evidence.';
    return { success: true, finalMessage, steps: stepsArchive, completedBy: 'jev_gate' };
  };
  
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
    const modelRouting = chooseJevTurnModel(nextJevStrategy, jevRoutingConfig, {
      provider: PROVIDER_ID,
      primaryModel: MODEL_ID,
    });
    if (forcePrimaryRetry) {
      modelRouting.selectedModel = MODEL_ID;
      modelRouting.applied = false;
      modelRouting.reason = 'routed_retry_primary';
      modelRouting.forcedPrimaryRetry = true;
      forcePrimaryRetry = false;
    }
    step.modelRouting = modelRouting;
    step.provider = PROVIDER_ID;
    step.model = modelRouting.selectedModel;
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
      const turnModel = modelRouting.selectedModel;
      const contextCheck = await warnIfContextNearLimit(turnModel, { messages, tools: activeToolsSchema });
      const projectedTokens = contextCheck.estimatedTokens
        ?? await tokenEstimate(turnModel, { messages, tools: activeToolsSchema });
      ({ totalTokensUsed, turnTimestamps, shouldBackoff } = await tokenUseCoolOff(
        totalTokensUsed,
        turnTimestamps,
        turnModel,
        projectedTokens
      ));
      if (shouldBackoff) {
        recordStep(step);
        turn -= 1;
        continue;
      }
      let modelResponse;
      try {
        modelResponse = await llm.chat({ model: turnModel, messages, tools: activeToolsSchema });
      } catch (routingError) {
        if (!modelRouting.applied) throw routingError;
        modelRouting.fallback = true;
        modelRouting.fallbackReason = routingError?.message || String(routingError);
        modelRouting.selectedModel = MODEL_ID;
        step.model = MODEL_ID;
        step.events.push(`↩️ Jev route fallback to ${MODEL_ID}`);
        modelResponse = await llm.chat({ model: MODEL_ID, messages, tools: activeToolsSchema });
      }
      const { message, usage, headers } = modelResponse;
      response = { message, usage, headers };
      updateLimitsFromHeaders(modelRouting.selectedModel, headers);

    } catch (err) {
      // ─────────────────────────────────────────────
      // STEP 3: Error and rate-limit handling
      // ─────────────────────────────────────────────
      if (err.status === 429) {
        let learned = {};
        try { learned = updateLimitsFromError(MODEL_ID, err); } catch {}
        const delay = Math.min(60000, learned.retryAfterMs ?? 2 ** retryCount * 2000);
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
      step.inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.providerRaw?.input_tokens ?? usage.providerRaw?.prompt_tokens;
      step.outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.providerRaw?.output_tokens ?? usage.providerRaw?.completion_tokens;
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
      const proposedTools = [];
      let hadToolIssues = false;
      let domRefreshSource = null;

      for (const call of msg.tool_calls) {
        const fnName = call.function.name;
        const args = JSON.parse(call.function.arguments || '{}');
        const safeArgs = redactArgs(fnName, args);
        proposedTools.push({ name: fnName, arguments: safeArgs });
        console.log(`[model] → ${fnName}`, safeArgs);
        step.events.push(`[model] → ${fnName} ${JSON.stringify(safeArgs)}`);

        let result;
        let errorMessage = null;
        try {
          if (fnName === 'set_ground_control_state') {
            applyGroundControlUpdate(groundControl, args);
            result = { ok: true, groundControl };
          } else if (fnName === 'record_mission_telemetry') {
            const recorded = recordGroundTelemetry(groundControl, args, { turn });
            result = { ok: true, recorded };
          } else {
            const toolHandler = CHROME_TOOL_MAP[fnName];
            if (typeof toolHandler !== 'function') throw new Error(`Unknown tool: ${fnName}`);
            result = await toolHandler(browser, args, agentMemory);
          }
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

        if (fnName === 'get_email_code') {
          step.emailCode = step.emailCode || {};
          step.emailCode.requested = true;
          try {
            const parsed = JSON.parse(result);
            step.emailCode.nickname = parsed.nickname || args.nickname || null;
            step.emailCode.status = parsed.ok ? 'provided' : parsed.code || 'unavailable';
            step.emailCode.senderDomain = parsed.senderDomain || null;
            step.emailCode.candidateCount = Array.isArray(parsed.codeCandidates) ? parsed.codeCandidates.length : 0;
            step.emailCode.match = parsed.match || null;
            agentMemory.lastEmailCodeLookup = parsed.ok
              ? {
                  ok: true,
                  nickname: parsed.nickname || args.nickname || null,
                  codeCandidates: parsed.codeCandidates || [],
                  senderDomain: parsed.senderDomain || null,
                }
              : {
                  ok: false,
                  nickname: parsed.nickname || args.nickname || null,
                  code: parsed.code,
                  error: parsed.error,
                  availableNicknames: parsed.availableNicknames || [],
                };
            step.events.push(parsed.ok
              ? `📧 Email code candidates retrieved for "${step.emailCode.nickname || 'configured inbox'}" (${step.emailCode.candidateCount} candidate${step.emailCode.candidateCount === 1 ? '' : 's'}).`
              : `📧 Email code unavailable: ${parsed.error || parsed.code || 'unknown error'}`);
          } catch {
            step.emailCode.status = errorMessage ? 'error' : 'unknown';
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
        if (fnName === 'get_email_code' && !errorMessage) {
          try {
            const parsed = JSON.parse(result);
            toolStatusLabel = parsed.ok
              ? `✅ ${Array.isArray(parsed.codeCandidates) ? parsed.codeCandidates.length : 0} candidate(s) retrieved`
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
          } else if (agentMemory.lastEmailCodeLookup?.ok && agentMemory.lastEmailCodeLookup.codeCandidates?.includes(fillText)) {
            sourceLine = `📧 Verification fill source: get_email_code nickname="${agentMemory.lastEmailCodeLookup.nickname || 'configured inbox'}"`;
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
        if (fnName === 'get_email_code') {
          try {
            const parsed = JSON.parse(result);
            resultForLog = JSON.stringify({
              ok: parsed.ok,
              code: parsed.code,
              error: parsed.error,
              nickname: parsed.nickname,
              senderDomain: parsed.senderDomain,
              receivedAt: parsed.receivedAt,
              candidateCount: Array.isArray(parsed.codeCandidates) ? parsed.codeCandidates.length : 0,
              match: parsed.match,
              availableNicknames: parsed.availableNicknames,
            });
          } catch {
            resultForLog = errorMessage || 'Email code lookup completed.';
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

        if (!errorMessage && fnName === 'get_dom') {
          agentMemory.browserEvidence = await captureBrowserEvidence(
            browser,
            result,
            agentMemory.browserEvidence,
          );
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

        // Defer automatic DOM injection until the originating assistant call
        // and all of its function responses are in history. Gemini requires a
        // model functionCall to immediately follow user content or a
        // functionResponse; inserting it before `msg` would create adjacent,
        // reversed model function-call turns.
        if (!errorMessage && ['click_text', 'click', 'expand_menu'].includes(fnName)) {
          domRefreshSource = fnName;
        }
      }

      // Merge new assistant + tool responses back into conversation
      messages.push(msg, ...toolResponses);
      if (domRefreshSource && !hadToolIssues) {
        console.log(`[auto] → Injecting DOM after ${domRefreshSource}...`);
        step.events.push(`[auto] → Injecting DOM after ${domRefreshSource}...`);
        const domRefresh = await pushDOMAssistant(browser, messages, agentMemory, {
          skipIfLastTool: ['get_dom', 'check_text'],
          limit: ctx.automaticDomLimit,
        });
        if (domRefresh?.injected) {
          console.log(`[auto] → DOM size after ${domRefreshSource}: ${domRefresh.domLength} chars`);
          step.events.push(`[auto] → DOM size after ${domRefreshSource}: ${domRefresh.domLength} chars`);
        }
      }
      await recordJevShadow(step, msg, hadToolIssues ? 'after_action_error' : 'after_action', proposedTools);
      if (!hadToolIssues) {
        const gatedResult = await finalizeWithJevGate(step);
        if (gatedResult) return gatedResult;
      }
      if (hadToolIssues && turnRetries < retryLimitClamped) {
        step.result = '⏳ Retrying turn';
        const retryNumber = attempt - 1;
        step.events.push(`🔁 Re-attempt ${retryNumber}/${retryLimitClamped} after tool issues`);
        recordStep(step);
        forcePrimaryRetry = modelRouting.applied;
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
      await recordJevShadow(step, msg, 'final_response');
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
      limit: ctx.automaticDomLimit,
    });
    console.log(`[auto] → Injected DOM for next reasoning step`);
    step.events.push(`[auto] → Injected DOM for next reasoning step`);
    await recordJevShadow(step, msg, 'after_observation');
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
