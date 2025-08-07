import 'dotenv/config';
import { ChromeBrowser } from '../tools/chromeBrowser.js';
import { turnLoop } from './turnLoop.js';

export async function runAgent(goals, missionName, maxTurns = 20, ) {
  const browser = new ChromeBrowser();
  await browser.start();
  const startTime = Date.now();

  try {
    for (const goal of goals) {
      // console.log(`\n🚀 Running Agent with goal:\n${goal}\n`);
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

      const success = await turnLoop(browser, messages, maxTurns);
      if (!success) {
        console.log('🛑 Agent stopped due to failed goal.\n');
        const endTime = Date.now();
        return {
          missionName: missionName,
          status: 'failed',
          steps: [ /* tool steps or key moments */ ],
          startTime: startTime,
          endTime: endTime,
        }
        ;
      }
    }

    console.log('✅ All goals completed successfully.\n');
    const endTime = Date.now();
    return {
      missionName: missionName,
      status: 'passed',
      steps: [ /* tool steps or key moments */ ],
      startTime: startTime,
      endTime: endTime,
    }
    ;

  } finally {
    await browser.close();
  }
}
