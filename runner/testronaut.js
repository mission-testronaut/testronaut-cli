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
    goals.push(...pre.map(fn => ({ goal: fn, label: 'pre-mission' })));
  }

  if (main.length) {
    goals.push(...main.map(fn => ({ goal: fn, label: 'mission' })));
  }

  if (post.length) {
    goals.push(...post.map(fn => ({ goal: fn, label: 'post-mission' })));
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
  console.log('\n✅ Mission flow complete.');
  return success;
}
