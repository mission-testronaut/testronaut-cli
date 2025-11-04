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


import { runAgent } from '../core/agent.js';
import { redactPasswordInText } from '../core/redaction.js';
import { loadConfig, enforceTurnBudget } from '../core/config.js';

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
  if (notes.length) {
    console.warn(notes.join('\n'));
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
  const success = await runAgent(goals, missionName, maxTurns);
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
