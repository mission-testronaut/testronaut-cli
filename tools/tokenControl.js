import { encoding_for_model, get_encoding } from '@dqbd/tiktoken';
import { wait } from './turnLoopUtils.js';

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
const DEFAULT_LIMITS = [
  // ── OpenAI (newer first) ────────────────────────────────────────────────
  { test: /^gpt-5(-|$)/i,               tpm:  90000 },
  { test: /^gpt-5-mini(-|$)/i,          tpm: 240000 },
  { test: /^gpt-5-nano(-|$)/i,          tpm: 600000 },

  { test: /^gpt-4o(-|$)/i,              tpm: 450000 },
  { test: /^gpt-4\.1(-|$)/i,            tpm:1000000 },

  { test: /^o3(-|$)/i,                  tpm: 300000 },
  { test: /^o4-mini(-|$)/i,             tpm: 600000 },

  // Older / fallback (OpenAI)
  { test: /^gpt-4(-|$)/i,               tpm: 150000 },
  { test: /^gpt-3\.5(-|$)/i,            tpm: 600000 },

  // ── Gemini (approximate, conservative) ─────────────────────────────────
  // These are heuristic defaults to guide local throttling only.
  { test: /^gemini-1\.5-pro(-|$)/i,     tpm: 120000 },
  { test: /^gemini-1\.5-flash-8b(-|$)/i,tpm: 300000 },
  { test: /^gemini-1\.5-flash(-|$)/i,   tpm: 300000 },

  // Ultimate fallback for anything else
  { test: /.*/,                         tpm: 150000 },
];

// Live, mutable limits (can be updated by headers at runtime)
const liveLimits = new Map(); // modelId -> { tpm, source: 'default'|'env'|'header' }

// One-time warning tracking for tokenizer fallback
const warnedModels = new Set();

/* ---------------- Tokenizer helpers ----------------
 * We prefer tiktoken's per-model encoding when available.
 * For unknown models (e.g., Gemini), we pick a close base:
 *  - o200k_base for modern, long-context or "1.5"-class models
 *  - cl100k_base as a broad fallback
 */
function getTokenizer(model) {
  try {
    return encoding_for_model(model);
  } catch (_) {
    const m = String(model || '').toLowerCase();

    // Explicit Gemini mapping → use o200k approximation for 1.5 models
    const isGemini15 = /^gemini-1\.5/.test(m);

    // OpenAI modern families also map well to o200k_base
    const useO200k =
      isGemini15 ||
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
 * Falls back to bytes/4 heuristic if tokenizer is not available.
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

/* ---------------- Dynamic limit resolution ---------------- */

function resolveDefaultLimitForModel(model) {
  // Highest priority: ENV override (forces a single limit for all models)
  const envTPM = process.env.TESTRONAUT_TOKENS_PER_MIN
    ? Number(process.env.TESTRONAUT_TOKENS_PER_MIN)
    : undefined;
  if (envTPM && Number.isFinite(envTPM) && envTPM > 0) {
    return { tpm: envTPM, source: 'env' };
  }

  // Otherwise find best-matching default (OpenAI or Gemini)
  const hit = DEFAULT_LIMITS.find(entry => entry.test.test(model || ''));
  return { tpm: hit?.tpm ?? 150000, source: 'default' };
}

/**
 * Public: get the current token-per-minute limit for a model.
 * Checks liveOverrides first (header-learned), then ENV, then defaults.
 */
export function getCurrentTokenLimit(model) {
  const m = (model || '').trim() || 'unknown';
  const live = liveLimits.get(m);
  if (live?.tpm) return live;

  const resolved = resolveDefaultLimitForModel(m);
  liveLimits.set(m, resolved);
  return resolved;
}

/**
 * Public: update limits from HTTP response headers (e.g., after 429).
 * Looks for typical headers like (OpenAI/Azure style, varies by provider):
 *  - x-ratelimit-limit-tokens
 *  - x-ratelimit-limit-tpm
 *  - x-ratelimit-limit-token
 *
 * If found, we store the new TPM for this model (source='header').
 * If a provider doesn't send such headers (e.g., Gemini), this is a no-op.
 */
export function updateLimitsFromHeaders(model, headers = {}) {
  if (!model) return;

  // Normalize header keys to lowercase
  const lower = {};
  for (const k of Object.keys(headers || {})) lower[k.toLowerCase()] = headers[k];

  const tokenCap =
    Number(lower['x-ratelimit-limit-tokens']) ||
    Number(lower['x-ratelimit-limit-tpm']) ||
    Number(lower['x-ratelimit-limit-token']) ||
    undefined;

  if (tokenCap && Number.isFinite(tokenCap) && tokenCap > 0) {
    const cur = getCurrentTokenLimit(model);
    if (cur.tpm !== tokenCap || cur.source !== 'header') {
      liveLimits.set(model, { tpm: tokenCap, source: 'header' });
      console.log(`📏 Updated TPM for ${model}: ${tokenCap} (from headers)`);
    }
  }
}

/* ---------------- Cooloff / backoff logic ---------------- */

export const tokenUseCoolOff = async (totalTokensUsed, turnTimestamps, model) => {
  const { tpm } = getCurrentTokenLimit(model);
  if (totalTokensUsed > tpm) {
    const msToWait = await getDynamicBackoffMs(turnTimestamps, tpm);
    console.warn(`⚠️ Token throttle risk (${totalTokensUsed}/${tpm}) → Waiting ${Math.ceil((msToWait || 1000)/1000)}s...`);
    await wait(msToWait || 1000);
    console.log('✅ Backoff complete, resuming...');
    return { shouldBackoff: true, totalTokensUsed: 0, turnTimestamps: [] };
  }
  return { shouldBackoff: false, totalTokensUsed, turnTimestamps };
};

export const recordTokenUsage = (turnTimestamps, tokensUsed) => {
  const now = Date.now();
  turnTimestamps.push([now, tokensUsed]);
};

export const pruneOldTokenUsage = (turnTimestamps, windowMs = 60000) => {
  const cutoff = Date.now() - windowMs;
  const recentEntries = turnTimestamps.filter(([timestamp]) => timestamp > cutoff);
  const totalTokensUsed = recentEntries.reduce((acc, [, tokens]) => acc + tokens, 0);
  return { turnTimestamps: recentEntries, totalTokensUsed };
};

const getDynamicBackoffMs = async (turnTimestamps, tokenLimit) => {
  const now = Date.now();
  let runningTotal = 0;

  const sorted = [...turnTimestamps].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length; i++) {
    runningTotal += sorted[i][1];
    if (runningTotal > tokenLimit) {
      const [timestampOfExcess] = sorted[i];
      const msUntilSafe = 60000 - (now - timestampOfExcess);
      return Math.max(msUntilSafe, 1000); // at least 1s
    }
  }
  return 0;
};
