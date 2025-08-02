import { runMissions } from '../runner/testronaut.js';
import { loginMission } from './login.mission.js';

export const logoutMission = `
    Locate and click the Logout button or link.
    The selector may be something like [data-testid="logout"] or a visible text node like "Logout" or "Sign out" or hidden under an avatar or username.
    After clicking, use 'check_text' to confirm you've returned to the login screen.
    You may need to use 'expand_menu' on a selector such as '[data-testid="user-dropdown-trigger"]'.
    After logging out, use 'check_text' to verify that "${process.env.AFTER_LOGOUT_CHECK}" appears on the page.
    If found, report SUCCESS. Otherwise, report FAILURE.
`;


// export const logoutMission = `
// If the logout button is not visible, expand the user menu by clicking the hamburger icon or profile avatar.
// Then click the button most likely to logout the user.
// After logging out, confirm that the login form or login page is shown or confirm that the words "${process.env.AFTER_LOGOUT_CHECK}" appear.
// If so, report SUCCESS. Otherwise, report FAILURE.`

export async function executeLogoutMission() {
  await runMissions({
    preMission: loginMission,
    mission: logoutMission
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeLogoutMission();
}