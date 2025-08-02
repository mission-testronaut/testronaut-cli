import { runWorkflow } from '../runner/agentRunner.js';
import { loginWorkflow } from '../workflows/loginWorkflow.js';

const workflows = [
  { name: 'Login Workflow', wf: loginWorkflow },
];

for (const { name, wf } of workflows) {
  console.log(`\n=== Running test: ${name} ===`);
  await runWorkflow(wf);
}

console.log('\n✅ All tests complete');