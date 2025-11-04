/**
 * agent.js
 * --------
 * Purpose:
 *   Orchestrate a browser-backed autonomous agent over a sequence of goals.
 *
 * Responsibilities:
 *   - Start/stop the browser lifecycle.
 *   - For each goal, construct initial messages and invoke turnLoop().
 *   - Collect per-goal traces into a normalized missionResults array.
 *
 * Message contract (initial):
 *   messages = [
 *     { role: 'system', content: 'instructions...' },
 *     { role: 'user',   content: <goal text> }
 *   ]
 *
 * Related tests:
 *   tests/agentTests/agent.test.js
 *
 * Used by:
 *   - cli/testronaut.js (runMissions)
 */

import 'dotenv/config';
import { ChromeBrowser } from '../tools/chromeBrowser.js';
import { turnLoop } from './turnLoop.js';

/**
 * Execute goals with a browser agent.
 *
 * @param {Array<{goal:any, submissionType?:string, submissionName?:string, label?:string}>} goals
 * @param {string} missionName
 * @param {number} [maxTurns=20] - upper bound for turnLoop per goal
 * @returns {Promise<Array<{missionName:string, submissionType:string, submissionName:string|null, status:'passed'|'failed', steps:any[], startTime:number, endTime:number}>>}
 */
export async function runAgent(goals, missionName, maxTurns = 20) {
  const browser = new ChromeBrowser();
  await browser.start();
  let result;

  try {
    const missionResults = [];

    for (const goal of goals) {
      const steps = [];

      // Ensure user message is a string (functions/objects → toString fallback)
      const userContent =
        typeof goal.goal === 'string'
          ? goal.goal
          : goal?.goal?.toString?.() ?? String(goal.goal);

      const messages = [
        {
          role: 'system',
          content: `
            You are an autonomous web agent. Use function calls to complete the user's goal.
            If you are unsure of the selectors for inputs or buttons, call 'get_dom' to retrieve page HTML,
            analyze it, then make your best guess based on labels, names, types, and placeholder values.
            If you want to click a button labeled "Sign out", prefer:

            click_text({ text: "Sign out" })

            Do NOT use CSS selectors like 'button:contains("Sign out")' — they are invalid.

            After completing the goal, respond with a final plain-text message starting with SUCCESS or FAILURE.
          `.trim(),
        },
        { role: 'user', content: userContent },
      ];

      // Run the turn loop for this goal
      result = await turnLoop(
        browser,
        messages,
        maxTurns,
        0,    // currentTurn
        0,    // retryCount
        null, // currentStep
        { steps, missionName }
      );

      // Snapshot steps (avoid retaining references to mutable arrays)
      missionResults.push({
        missionName,
        submissionType: goal.submissionType || goal.label,
        submissionName: goal.submissionName || null,
        status: result?.success ? 'passed' : 'failed',
        steps: JSON.parse(JSON.stringify(steps)), // deep-clone
        startTime: Date.now() - 1, // TODO: wire actual timings if needed
        endTime: Date.now(),
      });

      if (!result?.success) {
        console.log('🛑 Agent stopped due to failed goal.\n');
        return missionResults;
      }
    }

    console.log('✅ All goals completed successfully.\n');
    return missionResults;
  } finally {
    await browser.close();
  }
}
