import 'dotenv/config';
import { ChromeBrowser } from '../tools/chromeBrowser.js';
import { turnLoop } from './turnLoop.js';


// export async function runAgent(goal, maxTurns = 10) {
//   console.log(`\n🚀 Running Agent with goal: ${goal}`);
//   const browser = new ChromeBrowser();
//   await browser.start();

//   const messages = [
//     {
//       role: 'system',
//       content: `
//         You are an autonomous web agent. Use function calls to complete the user's goal.
//         If you are unsure of the selectors for inputs or buttons, call 'get_dom' to retrieve page HTML,
//         analyze it, then make your best guess based on labels, names, types, and placeholder values.
//         After completing the goal, respond with a final plain-text message starting with SUCCESS or FAILURE.
//       `.trim(),
//     },
//     { role: 'user', content: goal },
//   ];

//   try {
//     const result = await turnLoop(browser, messages, maxTurns);
//     !result && console.log('🛑 Agent ran out of turns.')
//   } finally {
//     await browser.close();
//   }
// }

export async function runAgent(goals, maxTurns = 20) {
  const browser = new ChromeBrowser();
  await browser.start();

  try {
    for (const goal of goals) {
      console.log(`\n🚀 Running Agent with goal:\n${goal}\n`);

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
        return false;
      }
    }

    console.log('✅ All goals completed successfully.\n');
    return true;

  } finally {
    await browser.close();
  }
}


// (async () => {
//   await runAgent(`
//     Visit ${process.env.URL}.
//     Log in using ${process.env.USERNAME} and password ${process.env.PASSWORD}.
//     After clicking the login button, use 'check_text' to verify that "${process.env.AFTER_LOGIN_CHECK}" appears on the page.
//     If found, report SUCCESS. Otherwise, report FAILURE.
//   `);
// })();