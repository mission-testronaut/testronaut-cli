import { runSuite } from './suiteRunner.js';

const objectives = [];

export function mission(name, fn) {
  console.log(`\n🚀 Mission: ${name}`);
  fn();
}

export function objective(goalDescription, workflow) {
  objectives.push({ name: goalDescription, workflow });
}

export async function launch(preMissionBootstrap) {
  await runSuite(objectives, preMissionBootstrap);
}
