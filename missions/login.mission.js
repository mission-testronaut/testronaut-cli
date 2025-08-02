import { runMissions } from '../runner/testronaut.js';

export const loginMission = `Visit ${process.env.URL}.
    Fill in the username field with ${process.env.USERNAME} and password field with ${process.env.PASSWORD}.
    Then click the button most likely to login the user.
    If the login is successful, confirm that the next page after login is shown by checking for text "${process.env.AFTER_LOGIN_CHECK}".
    If so, report SUCCESS stating the reason why. 
    Otherwise, report FAILURE stating the reason why.
  `

export async function executeLoginMission() {
  await runMissions({
    mission: loginMission
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeLoginMission();
}
