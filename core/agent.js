import 'dotenv/config';
import { ChromeBrowser } from '../tools/chromeBrowser.js';
import { turnLoop } from './turnLoop.js';

export async function runAgent(goals, missionName, maxTurns = 20, ) {
  const browser = new ChromeBrowser();
  await browser.start();
  const startTime = Date.now();
  let result;

  try {
    const missionResults = [];
    for (const goal of goals) {
      // console.log(`\n🚀 Running Agent with goal:\n${goal}\n`);
      const steps = [];
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
        { role: 'user', content: goal.goal },
      ];

      result = await turnLoop(
        browser, 
        messages, 
        maxTurns, 
        0, /* currentTurn */
        0, /* retryCount */
        null, /* currentStep */
        {
          steps,          // 👈 pass in
          missionName,    // 👈 pass in (for tagging)
        }
      );
      
      missionResults.push({
        missionName,
        status: result.success ? 'passed' : 'failed',
        steps: JSON.parse(JSON.stringify(steps)), // 👈 deep-clone to avoid refs
        startTime: Date.now() - 1, // set real values if you have them
        endTime: Date.now(),
      });

      if (!result.success) {
        console.log('🛑 Agent stopped due to failed goal.\n');
        return missionResults;
      }

      // if (!result.success) {
      //   console.log('🛑 Agent stopped due to failed goal.\n');
      //   const endTime = Date.now();
      //   return {
      //     missionName: missionName,
      //     status: 'failed',
      //     steps: result.steps,
      //     startTime: startTime,
      //     endTime: endTime,
      //   };
      // }
    }

    console.log('✅ All goals completed successfully.\n');
    // const endTime = Date.now();
    return missionResults;
    // return {
    //   missionName: missionName,
    //   status: 'passed',
    //   steps: result.steps,
    //   startTime: startTime,
    //   endTime: endTime,
    // };

  } finally {
    await browser.close();
  }
}
