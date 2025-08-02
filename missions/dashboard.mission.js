import { runMissions } from '../runner/testronaut.js';
import { loginMission } from './login.mission.js';
import { logoutMission } from './logout.mission.js';

export const dashboardMission = `use 'check_text' to verify that "${process.env.AFTER_LOGIN_CHECK}" appears on the page.
    If found, report SUCCESS. Otherwise, report FAILURE.`

export async function executeDashboardMission() {
  await runMissions({
    preMission: loginMission,
    mission: dashboardMission,
    postMission: logoutMission,
  });
}


if (import.meta.url === `file://${process.argv[1]}`) {
  executeDashboardMission();
}