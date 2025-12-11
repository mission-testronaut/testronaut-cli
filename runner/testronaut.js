/**
 * testronaut.js
 * -------------
 * Purpose:
 *   High-level mission runner: normalize pre/main/post submissions,
 *   compute a safe turn budget from config, and invoke the agent.
 *
 * Responsibilities:
 *   - Read config once and derive turn limits via enforceTurnBudget().
 *   - Build a normalized list of submissions with human-friendly names.
 *   - Redact sensitive text when logging mission strings.
 *   - Call runAgent(goals, missionName, maxTurns) and post-process status.
 *
 * Message contract (goal → initial messages inside agent):
 *   - system: operational guidance + success/failure contract
 *   - user:   the mission text (or coerced string)
 *
 * Related tests:
 *   tests/missionTests/testronaut.test.js
 *
 * Used by:
 *   - CLI entrypoint(s)
 */


import fs from 'fs';
import path from 'path';
import { runAgent } from '../core/agent.js';
import { redactPasswordInText } from '../core/redaction.js';
import { loadConfig, enforceTurnBudget, getRetryLimit, getDomListLimit, getResourceGuardConfig } from '../core/config.js';

// Check process env for debug toggles (shared helper for tests and CLI).
const isDebugEnabled = () => {
  const raw = String(process.env.TESTRONAUT_DEBUG || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
};

// Presentable string for DOM list limit logging/debug output.
const formatListLimit = (v) => v === Infinity ? 'all' : v;

/**
 * Run a mission flow.
 *
 * @param {{ preMission?: any|any[], mission?: any|any[], postMission?: any|any[] }} params
 * @param {string} missionName
 */
export async function runMissions({ preMission, mission, postMission }, missionName) {
  // 1) Config and turn budget (with guardrails)
  const cfg = await loadConfig();
  const { effectiveMax, limits, notes } = enforceTurnBudget(cfg);
  const maxTurns = effectiveMax;
  const retryInfo = getRetryLimit(cfg);
  const retryLimit = retryInfo.value;
  const domListLimitInfo = getDomListLimit(cfg);
  const resourceGuard = getResourceGuardConfig(cfg);
  const debugEnabled = isDebugEnabled();
  if (notes.length) {
    console.warn(notes.join('\n'));
  }
  if (retryInfo.clamped) {
    console.warn(`⚠️ Retry limit clamped to ${retryLimit} (allowed range 1-10).`);
  }
  if (domListLimitInfo?.clamped) {
    console.warn(`⚠️ DOM list limit clamped to ${domListLimitInfo.value} (allowed 0-100 or "all"/"none").`);
  }
  if (domListLimitInfo?.mode === 'all') {
    console.warn('⚠️ DOM list limit is set to "all". This can dramatically increase token usage and may break flows on heavy pages.');
  }
  if (debugEnabled) {
    const cfgDomRaw = cfg?.dom?.listItemLimit ?? cfg?.dom?.listLimit ?? cfg?.domListLimit;
    console.log('[debug] Debug mode enabled');
    console.log('[debug] Turn limits', {
      maxTurns,
      softMax: limits.softMaxTurns,
      hardMax: limits.hardMaxTurns,
      hardMin: limits.hardMinTurns,
    });
    console.log('[debug] Retry limit', { retryLimit, source: retryInfo.source, clamped: retryInfo.clamped });
    console.log('[debug] DOM list limit', {
      env: process.env.TESTRONAUT_DOM_LIST_LIMIT ?? 'unset',
      config: cfgDomRaw ?? 'unset',
      resolved: formatListLimit(domListLimitInfo?.value),
      mode: domListLimitInfo?.mode,
      source: domListLimitInfo?.source,
      clamped: domListLimitInfo?.clamped,
    });
    console.log('[debug] Resource guard', {
      enabled: resourceGuard.enabled,
      hrefIncludes: resourceGuard.hrefIncludes,
      dataTypes: resourceGuard.dataTypes,
    });
    // Helpful for upload missions: show missions/files contents
    const filesDir = path.resolve(process.cwd(), 'missions/files');
    try {
      const entries = fs.readdirSync(filesDir);
      const pdfs = entries.filter(f => f.toLowerCase().endsWith('.pdf'));
      console.log(`[debug] missions/files dir: ${filesDir}`);
      console.log(`[debug] missions/files entries (${entries.length}):`, entries);
      if (pdfs.length) console.log(`[debug] missions/files PDFs (${pdfs.length}):`, pdfs);
    } catch (err) {
      console.log(`[debug] missions/files not readable: ${err.message}`);
    }
  }

  // 2) Normalize submissions
  const normalizeToArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const pre  = normalizeToArray(preMission);
  const main = normalizeToArray(mission);
  const post = normalizeToArray(postMission);

  const goals = [];

  const pickName = (kind, fn, i) => {
    const baseFallback =
      kind === 'premission'   ? `pre-${i + 1}` :
      kind === 'postmission'  ? `post-${i + 1}` :
                                `mission-${i + 1}`;

    // MAIN mission: prefer the missionName argument
    if (kind === 'mission') {
      if (missionName) {
        // if multiple main items, disambiguate nicely
        const suffix = main.length > 1 ? ` (${i + 1}/${main.length})` : '';
        return `${missionName}${suffix}`;
      }
      // no missionName: if mission is a string, derive from its first non-empty line
      if (typeof fn === 'string') {
        const firstLine = (fn.trim().split('\n').find(Boolean) || fn.trim()).slice(0, 60);
        return firstLine.length === 60 ? `${firstLine}…` : firstLine || baseFallback;
      }
    }

    // PRE/POST (and fallback for mission): prefer author-provided labels on the function
    const explicit =
      fn?.submissionName || fn?.displayName || fn?.title || fn?.name;
    if (explicit && String(explicit).trim()) return String(explicit).trim();

    return baseFallback;
  };

  if (pre.length) {
    goals.push(
      ...pre.map((fn, i) => ({
        goal: fn,
        label: 'pre-mission',          // legacy label (kept for logs)
        submissionType: 'premission',  // normalized
        submissionName: pickName('premission', fn, i),
      }))
    );
  }

  if (main.length) {
    goals.push(
      ...main.map((fn, i) => ({
        goal: fn,
        label: 'mission',
        submissionType: 'mission',
        submissionName: pickName('mission', fn, i),
      }))
    );
  }

  if (post.length) {
    goals.push(
      ...post.map((fn, i) => ({
        goal: fn,
        label: 'post-mission',
        submissionType: 'postmission',
        submissionName: pickName('postmission', fn, i),
      }))
    );
  }

  console.log(
    '\n🧭 Running mission flow:\n',
    goals.map(g => {
      if (typeof g.goal === 'string') {
        // redact only the password literal in the human-readable mission text
        return `${g.label}: ${redactPasswordInText(g.goal)}`;
      }
      return `${g.label}: ${g.goal?.name || g.submissionName || g.goal}`;
    })
  );

  // 3) Execute
  const success = await runAgent(
    goals,
    missionName,
    maxTurns,
    retryLimit,
    { domListLimit: domListLimitInfo?.value, debug: debugEnabled, resourceGuard }
  );
  if (!success) {
    console.log(`❌ Aborting after failed goal.`);
    return;
  }

  const missionStatus = success[0].steps[success[0].steps.length - 1].result;
  if (missionStatus.toLowerCase().includes('failure')) {
    success[0].status = 'failed';
  }
  console.log('\n✅ Mission flow complete.');
  return success;
}

// Exposed for unit tests.
export const __test__ = { isDebugEnabled, formatListLimit };
