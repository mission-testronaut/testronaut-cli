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


export async function runMissions({ preMission, mission, postMission }) {
  const goals = [];

  if (preMission) {
    console.log('\n🧭 Running pre-mission setup:', preMission);
    goals.push({ goal: preMission, label: 'pre-mission' });
  }

  if (mission) {
    console.log('\n🧭 Running main mission:', mission);
    goals.push({ goal: mission, label: 'mission' });
  }

  if (postMission) {
    console.log('\n🧭 Running post-mission cleanup:', postMission);
    goals.push({ goal: postMission, label: 'post-mission' });
  }

console.log('\n🧭 Running mission flow:\n', goals);

  // for (const { goal, label } of goals) {
    // console.log(`\n🧭 Running ${label}:\n`);
  const success = await runAgent(goals);
  if (!success) {
    console.log(`❌ Aborting after failed goal.`);
    return;
  }
  // }
  console.log('\n✅ Mission flow complete.');
}
