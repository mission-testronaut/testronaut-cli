/**
 * config.js
 * ----------
 * Purpose:
 *   Centralized config loading and turn-budget guardrails for Testronaut.
 *
 * Responsibilities:
 *   - Load `testronaut-config.json` (best effort).
 *   - Read specific knobs with safe fallbacks (e.g., maxTurns).
 *   - Define baseline limits (soft/hard/min/idle/errors/time).
 *   - Enforce user requests via clamp + warn (default) or fail-fast (strict).
 *
 * Related tests:
 *   tests/configTests/config.test.js
 *
 * Used by:
 *   - cli/testronaut.js (to derive effectiveMax turns per run)
 *   - core/agent.js / core/turnLoop.js (runtime stop conditions)
 */

// core/config.js
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Load testronaut-config.json from the given cwd.
 * Returns {} when missing or invalid JSON.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {Promise<object>}
 */
export async function loadConfig(cwd = process.cwd()) {
  try {
    const raw = await readFile(path.join(cwd, 'testronaut-config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    // No config or invalid JSON — fall back to defaults at call sites
    return {};
  }
}

/**
 * Resolve the requested maxTurns from config with a safe fallback.
 *
 * @param {object} cfg
 * @param {number} [fallback=20]
 * @returns {number}
 */
export function getMaxTurns(cfg, fallback = 20) {
  const n = Number(cfg?.maxTurns);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve retry limit per turn (attempts - 1) with clamping.
 * Priority: env TESTRONAUT_RETRY_LIMIT → config.retryLimit → fallback
 *
 * @param {object} cfg
 * @param {number} [fallback=2]
 * @returns {{ value:number, source:'env'|'config'|'default', clamped:boolean }}
 */
export function getRetryLimit(cfg, fallback = 2) {
  const clampRetry = (n) => {
    const clamped = Math.min(10, Math.max(1, n));
    return { value: clamped, clamped: clamped !== n };
  };

  const envVal = Number(process.env.TESTRONAUT_RETRY_LIMIT);
  if (Number.isFinite(envVal)) {
    const { value, clamped } = clampRetry(envVal);
    return { value, source: 'env', clamped };
  }

  const cfgVal = Number(cfg?.retryLimit);
  if (Number.isFinite(cfgVal)) {
    const { value, clamped } = clampRetry(cfgVal);
    return { value, source: 'config', clamped };
  }

  const { value, clamped } = clampRetry(fallback);
  return { value, source: 'default', clamped };
}

/**
 * Resolve how many list-like items to keep in DOM snapshots.
 * - Accepts numbers (clamped 0-100), or the strings "all"/"none".
 * - Priority: env TESTRONAUT_DOM_LIST_LIMIT → config.dom.listItemLimit/listLimit/domListLimit → fallback.
 *
 * @param {object} cfg
 * @param {number} [fallback=3]
 * @returns {{ value:number|typeof Infinity, mode:'number'|'all'|'none', source:'env'|'config'|'default', clamped:boolean }}
 */
export function getDomListLimit(cfg, fallback = 3) {
  const clampList = (n) => {
    const clamped = Math.min(100, Math.max(0, n));
    return { value: clamped, clamped: clamped !== n };
  };

  const parseRaw = (raw) => {
    if (raw === undefined || raw === null) return null;

    if (typeof raw === 'string') {
      const lower = raw.trim().toLowerCase();
      if (!lower) return null;
      if (lower === 'all') return { value: Infinity, mode: 'all', clamped: false };
      if (lower === 'none') return { value: 0, mode: 'none', clamped: false };
      const num = Number(lower);
      if (!Number.isFinite(num)) return null;
      const { value, clamped } = clampList(num);
      return { value, mode: value === 0 ? 'none' : 'number', clamped };
    }

    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const { value, clamped } = clampList(raw);
      return { value, mode: value === 0 ? 'none' : 'number', clamped };
    }

    return null;
  };

  const envParsed = parseRaw(process.env.TESTRONAUT_DOM_LIST_LIMIT);
  if (envParsed) return { ...envParsed, source: 'env' };

  const cfgRaw = cfg?.dom?.listItemLimit ?? cfg?.dom?.listLimit ?? cfg?.domListLimit;
  const cfgParsed = parseRaw(cfgRaw);
  if (cfgParsed) return { ...cfgParsed, source: 'config' };

  const fbParsed = parseRaw(fallback);
  return { ...fbParsed, source: 'default' };
}

/**
 * Resolve resource guard settings for generic list/table harvesting.
 * - Patterns are used to detect resource anchors/data attributes.
 * - Enabled can be toggled via config.resourceGuard.enabled or TESTRONAUT_RESOURCE_GUARD.
 */
export function getResourceGuardConfig(cfg) {
  const parseBool = (raw) => {
    if (raw === undefined || raw === null) return null;
    const lower = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
    return null;
  };

  const defaultHrefPatterns = ['/document/', '/file/', '/download', '/attachment/'];
  const defaultDataTypes = ['document', 'file', 'item', 'row'];

  const envEnabled = parseBool(process.env.TESTRONAUT_RESOURCE_GUARD);
  const cfgEnabled = parseBool(cfg?.resourceGuard?.enabled);
  const enabled = envEnabled ?? cfgEnabled ?? true;

  const parseList = (raw) => {
    if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof raw === 'string') {
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  };

  const hrefIncludes = parseList(process.env.TESTRONAUT_RESOURCE_HREF_PATTERNS)
    || [];
  const dataTypes = parseList(process.env.TESTRONAUT_RESOURCE_DATA_TYPES)
    || [];

  const cfgHref = parseList(cfg?.resourceGuard?.hrefIncludes);
  const cfgTypes = parseList(cfg?.resourceGuard?.dataTypes);

  const finalHref = (hrefIncludes.length ? hrefIncludes : cfgHref.length ? cfgHref : defaultHrefPatterns).map(s => s.toLowerCase());
  const finalTypes = (dataTypes.length ? dataTypes : cfgTypes.length ? cfgTypes : defaultDataTypes).map(s => s.toLowerCase());

  return { enabled, hrefIncludes: finalHref, dataTypes: finalTypes };
}

/**
 * Baseline limits for mission runs. Adjust here for global defaults.
 *
 * @returns {{
 *   softMaxTurns:number,
 *   hardMaxTurns:number,
 *   hardMinTurns:number,
 *   maxIdleTurns:number,
 *   maxErrors:number,
 *   maxSeconds:number
 * }}
 */
export function resolveTurnLimits() {
  const softMaxTurns   = 50;
  const hardMaxTurns   = 200;
  const hardMinTurns   = 5;
  const maxIdleTurns   = 6;
  const maxErrors      = 5;
  const maxSeconds     = 600; //10 minutes

  return {
    softMaxTurns,
    hardMaxTurns,
    hardMinTurns,
    maxIdleTurns,
    maxErrors,
    maxSeconds,
  };
}

/**
 * Compute an effective turn budget and normalized limits from config.
 * - Default: clamp + warn (lenient).
 * - Strict mode (cfg.strictLimits or env STRICT_LIMITS): throw on violations.
 *
 * @param {object} cfg
 * @param {ReturnType<typeof resolveTurnLimits>} [baseLimits=resolveTurnLimits()]
 * @returns {{
 *   effectiveMax:number,
 *   limits: ReturnType<typeof resolveTurnLimits>,
 *   notes:string[],
 *   strict:boolean
 * }}
 */
export function enforceTurnBudget(cfg, baseLimits = resolveTurnLimits()) {
  const strict = !!(cfg?.strictLimits || process.env.STRICT_LIMITS);

  const limits = { ...baseLimits };
  const notes = [];

  // Normalize soft/hard ordering
  if (limits.softMaxTurns > limits.hardMaxTurns) {
    if (strict) throw new Error(`[limits] softMaxTurns (${limits.softMaxTurns}) > hardMaxTurns (${limits.hardMaxTurns}).`);
    notes.push(`Adjusted softMaxTurns down to hardMaxTurns (${limits.hardMaxTurns}).`);
    limits.softMaxTurns = limits.hardMaxTurns;
  }
  if (limits.hardMinTurns > limits.softMaxTurns) {
    if (strict) throw new Error(`[limits] hardMinTurns (${limits.hardMinTurns}) > softMaxTurns (${limits.softMaxTurns}).`);
    notes.push(`Adjusted hardMinTurns down to softMaxTurns (${limits.softMaxTurns}).`);
    limits.hardMinTurns = limits.softMaxTurns;
  }

  // Resolve requested maxTurns (env override wins over config)
  const envTurns = Number(process.env.TESTRONAUT_TURNS);
  const hasEnv = Number.isFinite(envTurns) && envTurns > 0;
  const cfgTurns = Number(cfg?.maxTurns);
  const hasCfg = Number.isFinite(cfgTurns) && cfgTurns > 0;
  let requested = hasEnv ? envTurns : (hasCfg ? cfgTurns : 20);
  let effectiveMax = requested;

  if (hasEnv) {
    notes.push(`ℹ️ Using CLI turn override (TESTRONAUT_TURNS=${envTurns}).`);
  }

  if (effectiveMax > limits.hardMaxTurns) {
    const msg = `maxTurns (${effectiveMax}) exceeds hardMaxTurns (${limits.hardMaxTurns}).`;
    if (strict) throw new Error(`[limits] ${msg}`);
    notes.push(`⚠️ ${msg} Clamping to ${limits.hardMaxTurns}.`);
    effectiveMax = limits.hardMaxTurns;
  } else if (effectiveMax > limits.softMaxTurns) {
    const msg = `maxTurns (${effectiveMax}) exceeds softMaxTurns (${limits.softMaxTurns}).`;
    if (strict) throw new Error(`[limits] ${msg}`);
    notes.push(`⚠️ ${msg} Proceeding, but consider lowering to control cost.`);
  } else if (effectiveMax < limits.hardMinTurns) {
    const msg = `maxTurns (${effectiveMax}) is below hardMinTurns (${limits.hardMinTurns}).`;
    if (strict) throw new Error(`[limits] ${msg}`);
    notes.push(`⚠️ ${msg} Raising to ${limits.hardMinTurns}.`);
    effectiveMax = limits.hardMinTurns;
  }

  return { effectiveMax, limits, notes, strict };
}
