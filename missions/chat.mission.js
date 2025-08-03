import { runMissions } from '../runner/testronaut.js';
import { loginMission } from './login.mission.js';
import { logoutMission } from './logout.mission.js';
import { startPublicChatMission } from './startPublicChat.mission.js';

export const chatMission = 
`Input the text "give me the main categories for compliance for AER" into the text field with the placeholder text "Chat with an AI".
Then submit the message.
You will likely need to wait several seconds for a response (about 30 seconds).
The response will appear in the text response section of the page.
the response will be a thoughtfull response from an LLM.
Check if this response was sent and if it was related to the question asked.
If found, report SUCCESS. Otherwise, report FAILURE.`

export async function executeDashboardMission() {
  await runMissions({
    preMission: [loginMission, startPublicChatMission],
    mission: chatMission,
    postMission: logoutMission,
  });
}


if (import.meta.url === `file://${process.argv[1]}`) {
  executeDashboardMission();
}