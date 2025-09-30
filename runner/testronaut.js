import { runAgent } from '../core/agent.js';
import { redactPasswordInText } from '../core/redaction.js';
// import { runSuite } from './suiteRunner.js';

// const objectives = [];

// export function mission(title, fn) {
//   console.log(`\n🚀 Mission: ${title}`);
//   fn();
// }

// export function objective(desc, workflow) {
//   objectives.push({ name: desc, workflow });
// }

// export async function launch(preMissionSetup) {
//   await runSuite(objectives, preMissionSetup);
// }



export async function runMissions({ preMission, mission, postMission }, missionName) {
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

  const success = await runAgent(goals, missionName);
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
