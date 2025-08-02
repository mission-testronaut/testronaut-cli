import { Browser } from '../core/browser.js';
import { TOOL_MAP } from '../core/tools.js';

export async function runWorkflow(workflow) {
  const browser = new Browser();
  await browser.start();

  try {
    for (const step of workflow.steps) {
      const fn = TOOL_MAP[step.type];
      if (!fn) throw new Error(`Unsupported step: ${step.type}`);

      const result = await fn(browser, step);
      console.log(`[${step.type}] → ${result}`);

      if (step.expect && !result.includes('FOUND')) {
        throw new Error(`Expectation failed: ${step.text}`);
      }
    }
    console.log('\n✅ Workflow complete: SUCCESS');
  } catch (err) {
    console.error('\n❌ Workflow failed:', err.message);
  } finally {
    await browser.close();
  }
}