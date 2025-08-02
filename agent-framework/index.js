import { runWorkflow } from './runner/agentRunner.js';
import { loginWorkflow } from './workflows/loginWorkflow.js';

(async () => {
  await runWorkflow(loginWorkflow);
})();