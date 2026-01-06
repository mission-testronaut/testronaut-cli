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
import { createEmptyGroundControl, summarizeGroundControlForPrompt } from '../tools/contextControl.js';
import fs from 'fs';
import path from 'path';

/**
 * Execute goals with a browser agent.
 *
 * @param {Array<{goal:any, submissionType?:string, submissionName?:string, label?:string}>} goals
 * @param {string} missionName
 * @param {number} [maxTurns=20] - upper bound for turnLoop per goal
 * @param {number} [retryLimit]
 * @param {{ domListLimit?: number|typeof Infinity, debug?: boolean, resourceGuard?: { enabled:boolean, hrefIncludes:string[], dataTypes:string[] } }} [opts]
 * @returns {Promise<Array<{missionName:string, submissionType:string, submissionName:string|null, status:'passed'|'failed', steps:any[], startTime:number, endTime:number}>>}
 */
export async function runAgent(goals, missionName, maxTurns = 20, retryLimit, opts = {}) {
  const browser = new ChromeBrowser({
    domListLimit: opts.domListLimit,
    debug: opts.debug,
    resourceGuard: opts.resourceGuard,
  });
  await browser.start();
  let result;

  try {
    const missionResults = [];
    const tmpDir = path.resolve(process.cwd(), 'missions/tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    // 🔭 Shared Ground Control state across all goals/missions
    const groundControl = createEmptyGroundControl();

    for (const goal of goals) {
      const steps = [];
      const stepsArchive = [];
      // Unique-ish JSONL file for this mission’s steps
      const stepFile = path.join(
        tmpDir,
        `${missionName.replace(/[^\w.-]+/g, '_')}_${Date.now()}_steps.jsonl`
      );
      // Start clean
      fs.writeFileSync(stepFile, '');

      // Ensure user message is a string (functions/objects → toString fallback)
      const userContent =
        typeof goal.goal === 'string'
          ? goal.goal
          : goal?.goal?.toString?.() ?? String(goal.goal);

      // 🔭 Build a compact Ground Control snapshot for the prompt
      const groundSummary = summarizeGroundControlForPrompt(groundControl);
      let systemContent = `
You are an autonomous web agent piloting a browser for end-to-end testing.

Core behavior:
- Use function calls to complete the user's goal.
- If you are unsure of selectors for inputs or buttons, call 'get_dom' to retrieve page HTML,
  analyze it, then choose selectors based on labels, names, types, and placeholder values.
- If you want to click a button labeled "Sign out", prefer:

  click_text({ text: "Sign out" })

  Do NOT use CSS selectors like 'button:contains("Sign out")' — they are invalid.

After completing the goal, respond with a final plain-text message starting with
either "SUCCESS:" or "FAILURE:" followed by a short explanation.

──── Ground Control (persistent mission state) ────
You also have special tools to manage a compact, non-pruned state called "Ground Control".
Ground Control tracks high-level truths about the app and session, such as:

- app:       { baseUrl, currentUrl, routeRole }          // where the app lives and where you are now
- session:   { loggedIn, userLabel, tenant }             // login state and identity
- navigation:{ currentLabel }                            // human label for the current view
- constraints:{ stayWithinBaseUrl }                      // domain / navigation constraints
- telemetry: [{ ts, kind, text, status, turn, extra }]   // optional breadcrumbs

You have two Ground Control tools:

1) establish_ground_control
   - Use this EARLY in a mission/phase once you understand key facts, e.g.:
     - The base URL (e.g. "https://ult.ultimarii.app")
     - The current URL and what the page represents (routeRole: "login", "chat", "dashboard", etc.)
     - Whether you are logged in or not.
   - Call it once per mission phase (premission / mission / postmission) when you first
     have a clear picture of where you are and what the app state is.
   - Provide as many known fields as you can, but do not guess wildly. Unknown fields can be omitted.

2) update_ground_control
   - Use this when important truths change or become clearer, for example:
     - URL or routeRole changes after navigation or login.
     - Login state changes (loggedIn false → true or vice versa).
     - You discover the displayed user name or tenant.
     - You identify a new page role (e.g. "chat", "settings", "feedback-form").
   - Only update fields that changed or that you now know with more confidence.
   - Optionally add short telemetry breadcrumbs about major milestones,
     e.g. "Logged in and reached chat workspace".

General rules:
- Keep Ground Control high-level and stable; do NOT spam small, noisy updates.
- Before leaving a page for a new flow, make sure Ground Control reflects the currentUrl
  and routeRole so you can reason about where you are and where you’ve been.
- Respect constraints (e.g. stayWithinBaseUrl = true) when deciding whether it is safe to navigate.

Use Ground Control as your persistent mission memory about:
- Where the app lives (baseUrl),
- Where you are (currentUrl, routeRole),
- Who you are logged in as (session),
- Any constraints about staying on the correct site.
      `.trim();

      if (groundSummary) {
        systemContent +=
          '\n\n' +
          `
──── Ground Control Snapshot ────
🛰️ ${JSON.stringify(groundSummary, null, 2)}
          `.trim();
      }

      const messages = [
        { role: 'system', content: systemContent },
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
        {
          steps,
          stepsArchive,
          missionName,
          retryLimit, 
          groundControl,
          resourceGuard: opts.resourceGuard,
          onStep: (s) => {
            // Append each step as a JSON line
            try {
              fs.appendFileSync(stepFile, JSON.stringify(s) + '\n');
              // Keep memory in check: retain only the last ~20 steps in RAM
              if (steps.length > 20) steps.splice(0, steps.length - 20);
              stepsArchive.push(s);
            } catch {} // best-effort; don’t crash the agent
          }
        }
      );

      function dedupeSteps(steps) {
        const copy = [...steps];
        copy.sort((a, b) => {
          if (Number.isFinite(a?._seq) && Number.isFinite(b?._seq)) {
            return a._seq - b._seq;
          }
          return (a?.turn ?? 0) - (b?.turn ?? 0);
        });
        return copy;
      }

      const compact = dedupeSteps(stepsArchive.length ? stepsArchive : steps);

      // Snapshot steps (avoid retaining references to mutable arrays)
      missionResults.push({
        missionName,
        submissionType: goal.submissionType || goal.label,
        submissionName: goal.submissionName || null,
        status: result?.success ? 'passed' : 'failed',
        steps: JSON.parse(JSON.stringify(compact)), // last 20 (by memory design)
        stepFile, // full history is in this JSONL (one step per line)
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
