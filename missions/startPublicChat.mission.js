import { runMissions } from '../runner/testronaut.js';
import { loginMission } from './login.mission.js';
import { logoutMission } from './logout.mission.js';

export const startPublicChatMission = `Start a chat by clicking the first chat button under the public libraries.
To confirm if a chat has started a text field with the place holder text "Chat with an AI" should appear.
If found, report SUCCESS. Otherwise, report FAILURE.`

export async function executeDashboardMission() {
  await runMissions({
    preMission: loginMission,
    mission: startPublicChatMission,
    postMission: logoutMission,
  });
}


if (import.meta.url === `file://${process.argv[1]}`) {
  executeDashboardMission();
}