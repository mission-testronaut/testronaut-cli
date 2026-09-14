/**
 * tokenControl.js
 * ----------------
 * Purpose:
 *   Centralized token counting and throttling utilities for Testronaut.
 *   Provides per-model token estimation, dynamic token-per-minute (TPM)
 *   limits, adaptive backoff, and header-learned limit updates.
 *
 * Responsibilities:
 *   - Estimate token counts (prefer model encodings; fallback to bytes/4 heuristic).
 *   - Determine current TPM limit (defaults → ENV override → header-learned).
 *   - Track rolling token usage and apply cooldowns to avoid rate limits.
 *   - Accept provider headers (e.g., OpenAI) to update live TPM caps.
 *
 * Related tests:
 *   Located in `tests/toolsTests/`
 *
 * Used by:
 *   - core/turnLoop.js (rate limiting & accounting)
 *   - tools that need token estimation before pushing large DOM payloads
 */

import { encoding_for_model, get_encoding } from '@dqbd/tiktoken';
import { wait } from './turnLoopUtils.js';
import { getOpenAIModel } from '../llm/openAI/models.js';
import { getFallbackTPM } from './rateLimitDefaults.js';

/**
 * Dynamic token-per-minute limits by model family.
 * - You can tweak these defaults anytime.
 * - ENV override: TESTRONAUT_TOKENS_PER_MIN forces a single limit for everything.
 * - At runtime, you can call `updateLimitsFromHeaders(model, headers)` after a 429
 *   to adopt server-advertised limits (if present).
 *
 * NOTE: These are conservative defaults meant for backoff heuristics, not hard truths.
 *       Providers may change limits; env/header learning will supersede these.
 */
/* Legacy model table moved to rateLimitDefaults.js so init and runtime share it. */
// Live, mutable limits (can be updated by headers at runtime)
const liveLimits = new Map(); // modelId -> { tpm, source: 'default'|'env'|'header' }

// One-time warning tracking for tokenizer fallback
const warnedModels = new Set();
let runtimeContext = { provider: undefined, rateLimits: undefined };
let overrideNoticeShown = false;

function getEnvironmentTPMOverride() {
  const raw = String(process.env.TESTRONAUT_TOKENS_PER_MIN ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function configureTokenControl({ provider, rateLimits } = {}) {
  runtimeContext = { provider, rateLimits };
  liveLimits.clear();
  const envTPM = getEnvironmentTPMOverride();
  if (envTPM && !overrideNoticeShown) {
    console.warn(
      `⚠️ TPM override active: TESTRONAUT_TOKENS_PER_MIN=${envTPM}. ` +
      'This value overrides config and provider-advertised limits.\n' +
      '   Clear it permanently with `unset TESTRONAUT_TOKENS_PER_MIN` and remove it from `.env` or your shell profile.\n' +
      '   Bypass it for one run with `TESTRONAUT_TOKENS_PER_MIN=auto testronaut <mission>`.'
    );
    overrideNoticeShown = true;
  }
}

/* ---------------- Tokenizer helpers ----------------
 * We prefer tiktoken's per-model encoding when available.
 * For unknown models, we pick a close base:
 *  - o200k_base for modern, long-context families (OpenAI, Gemini, Claude, O*)
 *  - cl100k_base as a broad fallback
 */
/**
 * Resolve the best-effort tokenizer for a model.
 * Falls back to o200k_base for modern long-context models and cl100k_base otherwise.
 *
 * @param {string} model - Model identifier used to pick an encoding.
 * @returns {import('@dqbd/tiktoken').Tiktoken | null} tokenizer or null on failure
 */
function getTokenizer(model) {
  try {
    return encoding_for_model(model);
  } catch (_) {
    const m = String(model || '').toLowerCase();

    // Treat Gemini 2.5 like modern long-context models
    const isGemini25 = /^gemini-2\.5/.test(m);
    const isClaude = /^claude-/.test(m);

    // OpenAI modern families also map well to o200k_base
    const useO200k =
      isGemini25 ||
      isClaude ||
      m.startsWith('gpt-5') ||
      m.startsWith('gpt-4o') ||
      m.startsWith('gpt-4.1') ||
      m.startsWith('o') ||
      m.includes('omni');

    try {
      return get_encoding(useO200k ? 'o200k_base' : 'cl100k_base');
    } catch (e2) {
      if (!warnedModels.has(model)) {
        console.warn(`⚠️ Could not load tokenizer for "${model}". Will approximate by bytes/4.`, e2?.message || e2);
        warnedModels.add(model);
      }
      return null;
    }
  }
}

/**
 * Estimate tokens for a given text under a model family.
 * Prefers a real tokenizer; falls back to bytes/4 heuristic.
 *
 * @param {string} model - Model identifier (e.g., 'gpt-4o', 'gemini-2.5-flash')
 * @param {string|any} text - Text or JSON-like payload to estimate
 * @returns {Promise<number>} estimated token count
 */
export const tokenEstimate = async (model, text) => {
  const str = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  const enc = getTokenizer(model);

  if (enc) {
    try {
      const tokenCount = enc.encode(str).length;
      enc.free?.();
      console.log(`🧠 Estimated token count (${model}): ${tokenCount}`);
      return tokenCount;
    } catch (e) {
      enc.free?.();
      if (!warnedModels.has(model)) {
        console.warn(`⚠️ Tokenizer encode failed for "${model}". Falling back to bytes/4.`, e?.message || e);
        warnedModels.add(model);
      }
    }
  }

  // Final fallback: rough heuristic (UTF-8 bytes / 4)
  const bytes = Buffer.from(str, 'utf8').length;
  const approx = Math.ceil(bytes / 4);
  console.log(`🧠 Estimated token count (approx, ${model}): ${approx}`);
  return approx;
};

/**
 * Warn when a request is close to a known model context window. This is a
 * diagnostic only: Testronaut does not truncate or compact content here.
 */
export async function warnIfContextNearLimit(model, payload, threshold = 0.9) {
  const contextWindow = getOpenAIModel(model)?.contextWindow;
  if (!contextWindow) return { warned: false };

  const estimatedTokens = await tokenEstimate(model, payload);
  const warned = estimatedTokens >= contextWindow * threshold;
  if (warned) {
    console.warn(
      `⚠️ Estimated request context for ${model} is ${estimatedTokens}/${contextWindow} tokens. ` +
      'Testronaut will send it unchanged; consider reducing mission or tool history.'
    );
  }
  return { warned, estimatedTokens, contextWindow };
}

/* ---------------- Dynamic limit resolution ---------------- */

/**
 * Resolve a default TPM for a model:
 * - ENV override takes precedence (TESTRONAUT_TOKENS_PER_MIN)
 * - Otherwise match regex patterns in DEFAULT_LIMITS
 * @param {string} model
 * @returns {{tpm:number, source:'default'|'env'}}
 */
function resolveDefaultLimitForModel(model) {
  const envTPM = getEnvironmentTPMOverride();
  if (envTPM) {
    return { tpm: envTPM, source: 'env' };
  }

  const modelConfig = runtimeContext.rateLimits?.models?.[model] || {};
  const configuredTPM = Number(modelConfig.tpm);
  if (Number.isFinite(configuredTPM) && configuredTPM > 0) {
    return { tpm: configuredTPM, source: 'config' };
  }
  const fallbackTPM = Number(modelConfig.fallbackTPM);
  return {
    tpm: Number.isFinite(fallbackTPM) && fallbackTPM > 0
      ? fallbackTPM
      : getFallbackTPM(runtimeContext.provider, model),
    source: Number.isFinite(fallbackTPM) && fallbackTPM > 0 ? 'config-fallback' : 'default',
  };
}

function resolveExplicitLimitForModel(model) {
  const envTPM = getEnvironmentTPMOverride();
  if (envTPM) return { tpm: envTPM, source: 'env' };
  const configuredTPM = Number(runtimeContext.rateLimits?.models?.[model]?.tpm);
  if (Number.isFinite(configuredTPM) && configuredTPM > 0) {
    return { tpm: configuredTPM, source: 'config' };
  }
  return null;
}

/**
 * Get the current token-per-minute limit for a model.
 * Priority: header-learned (live) → ENV → defaults.
 *
 * @param {string} model
 * @returns {{tpm:number, source:'default'|'env'|'header'}}
 */
export function getCurrentTokenLimit(model) {
  const m = (model || '').trim() || 'unknown';
  const explicit = resolveExplicitLimitForModel(m);
  if (explicit) return explicit;
  const live = liveLimits.get(m);
  if (live?.tpm) return live;

  const resolved = resolveDefaultLimitForModel(m);
  liveLimits.set(m, resolved);
  return resolved;
}

/**
 * Update TPM from HTTP response headers (e.g., after 429).
 * Looks for common provider headers (OpenAI/Azure style). No-op if absent.
 *
 * @param {string} model
 * @param {Record<string, string|number>} headers
 */
export function updateLimitsFromHeaders(model, headers = {}) {
  if (!model) return;

  // Normalize header keys to lowercase
  const lower = {};
  if (typeof headers?.forEach === 'function') {
    headers.forEach((value, key) => { lower[String(key).toLowerCase()] = value; });
  } else {
    for (const k of Object.keys(headers || {})) lower[k.toLowerCase()] = headers[k];
  }

  const tokenCap =
    Number(lower['x-ratelimit-limit-tokens']) ||
    Number(lower['x-ratelimit-limit-tpm']) ||
    Number(lower['x-ratelimit-limit-token']) ||
    undefined;

  if (tokenCap && Number.isFinite(tokenCap) && tokenCap > 0) {
    const cur = getCurrentTokenLimit(model);
    if (cur.tpm !== tokenCap || cur.source !== 'header') {
      liveLimits.set(model, {
        tpm: tokenCap,
        remainingTokens: numericHeader(lower['x-ratelimit-remaining-tokens']),
        resetTokens: lower['x-ratelimit-reset-tokens'],
        rpm: numericHeader(lower['x-ratelimit-limit-requests']),
        remainingRequests: numericHeader(lower['x-ratelimit-remaining-requests']),
        resetRequests: lower['x-ratelimit-reset-requests'],
        source: 'header',
        observedAt: Date.now(),
      });
      console.log(`📏 Updated TPM for ${model}: ${tokenCap} (from headers)`);
    }
  }
}

function numericHeader(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function updateLimitsFromError(model, error = {}) {
  const headers = error.headers || error.response?.headers || {};
  updateLimitsFromHeaders(model, headers);
  const retryAfter = typeof headers?.get === 'function'
    ? headers.get('retry-after')
    : headers?.['retry-after'];
  const message = String(error.message || error.error?.message || '');
  const retryMatch = message.match(/retry(?: in| after)?\s+([0-9.]+)s/i);
  const seconds = Number(retryAfter ?? retryMatch?.[1]);
  return { retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined };
}

/* ---------------- Cooloff / backoff logic ---------------- */

/**
 * If usage exceeds TPM, wait until safe and reset rolling counters.
 *
 * @param {number} totalTokensUsed - rolling 60s total
 * @param {Array<[number,number]>} turnTimestamps - [[tsMs, tokens], ...]
 * @param {string} model - model id for TPM lookup
 * @returns {Promise<{shouldBackoff:boolean,totalTokensUsed:number,turnTimestamps:Array}>}
 */
export const tokenUseCoolOff = async (totalTokensUsed, turnTimestamps, model, projectedTokens = 0) => {
  const { tpm } = getCurrentTokenLimit(model);
  const margin = Number(runtimeContext.rateLimits?.safetyMargin);
  const effectiveLimit = tpm * (Number.isFinite(margin) && margin > 0 && margin <= 1 ? margin : 0.9);
  const projectedTotal = totalTokensUsed + Math.max(0, Number(projectedTokens) || 0);
  if (projectedTotal > effectiveLimit && turnTimestamps.length) {
    const msToWait = await getDynamicBackoffMs(turnTimestamps, Math.max(0, effectiveLimit - projectedTokens));
    console.warn(`⚠️ Token throttle risk (${Math.ceil(projectedTotal)}/${Math.floor(effectiveLimit)}) → Waiting ${Math.ceil((msToWait || 1000)/1000)}s...`);
    await wait(msToWait || 1000);
    console.log('✅ Backoff complete, resuming...');
    const refreshed = pruneOldTokenUsage(turnTimestamps);
    return { shouldBackoff: true, ...refreshed };
  }
  return { shouldBackoff: false, totalTokensUsed, turnTimestamps };
};

/**
 * Record tokens for the current turn in the rolling window.
 * @param {Array<[number,number]>} turnTimestamps
 * @param {number} tokensUsed
 * @returns {void}
 */
export const recordTokenUsage = (turnTimestamps, tokensUsed) => {
  const now = Date.now();
  turnTimestamps.push([now, tokensUsed]);
};

/**
 * Remove entries older than `windowMs` from the rolling window.
 * @param {Array<[number,number]>} turnTimestamps
 * @param {number} windowMs
 * @returns {{turnTimestamps:Array<[number,number]>, totalTokensUsed:number}}
 */
export const pruneOldTokenUsage = (turnTimestamps, windowMs = 60000) => {
  const cutoff = Date.now() - windowMs;
  const recentEntries = turnTimestamps.filter(([timestamp]) => timestamp > cutoff);
  const totalTokensUsed = recentEntries.reduce((acc, [, tokens]) => acc + tokens, 0);
  return { turnTimestamps: recentEntries, totalTokensUsed };
};

/**
 * Compute milliseconds to wait until under TPM again.
 * Walks the sorted window and finds when usage first exceeds TPM.
 *
 * @param {Array<[number,number]>} turnTimestamps
 * @param {number} tokenLimit
 * @returns {Promise<number>} ms to wait (>= 0)
 */
const getDynamicBackoffMs = async (turnTimestamps, tokenLimit) => {
  const now = Date.now();
  const sorted = [...turnTimestamps].sort((a, b) => a[0] - b[0]);
  let remainingTotal = sorted.reduce((sum, [, tokens]) => sum + tokens, 0);
  for (let i = 0; i < sorted.length; i++) {
    remainingTotal -= sorted[i][1];
    if (remainingTotal <= tokenLimit) {
      const [timestampToExpire] = sorted[i];
      const msUntilSafe = 60000 - (now - timestampToExpire);
      return Math.max(msUntilSafe, 1000); // at least 1s
    }
  }
  return 0;
};


/**
 * Test-only helper to clear internal state between runs.
 * @returns {void}
 */
export function __resetTokenControlForTests() {
  liveLimits.clear();
  warnedModels.clear();
  runtimeContext = { provider: undefined, rateLimits: undefined };
  overrideNoticeShown = false;
}
