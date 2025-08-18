import { runAgent } from '../core/agent.js';
import { runSuite } from './suiteRunner.js';

const objectives = [];

export function mission(title, fn) {
  console.log(`\n🚀 Mission: ${title}`);
  fn();
}

export function objective(desc, workflow) {
  objectives.push({ name: desc, workflow });
}

export async function launch(preMissionSetup) {
  await runSuite(objectives, preMissionSetup);
}

export async function runMissions({ preMission, mission, postMission }, missionName) {
  const normalizeToArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  
  const pre = normalizeToArray(preMission);
  const main = normalizeToArray(mission);
  const post = normalizeToArray(postMission);

  const goals = [];

  if (pre.length) {
    goals.push(
      ...pre.map((fn, i) => ({
        goal: fn,
        label: 'pre-mission',              // legacy label
        submissionType: 'premission',      // normalized
        submissionName: fn?.name || `pre-${i + 1}`,
      }))
    );
  }

  if (main.length) {
    goals.push(
      ...main.map((fn, i) => ({
        goal: fn,
        label: 'mission',
        submissionType: 'mission',
        submissionName: fn?.name || `mission-${i + 1}`,
      }))
    );
  }

  if (post.length) {
    goals.push(
      ...post.map((fn, i) => ({
        goal: fn,
        label: 'post-mission',
        submissionType: 'postmission',
        submissionName: fn?.name || `post-${i + 1}`,
      }))
    );
  }

  console.log(
    '\n🧭 Running mission flow:\n',
    goals.map(g => `${g.label}: ${g.goal?.name ?? g.goal}`)
  );
  
  const success = await runAgent(goals, missionName);
  if (!success) {
    console.log(`❌ Aborting after failed goal.`);
    return;
  }
  // console.log("success[0]: ", success[0]);
  // console.log("success[0].steps.length: ", success[0].steps.length);
  // console.log("success[0].steps[success[0].steps.length - 1].result: ", success[0].steps[success[0].steps.length - 1].result)
  const missionStatus = success[0].steps[success[0].steps.length - 1].result;
  // console.log("missionStatus: ", missionStatus)
  if (missionStatus.toLowerCase().includes('failure')) {
    // console.log("we detected the failure!")
    success[0].status = 'failed';
  }
  console.log('\n✅ Mission flow complete.');
  return success;
}
