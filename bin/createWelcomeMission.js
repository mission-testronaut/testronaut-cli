import fs from 'fs';
import path from 'path';

export const createWelcomeMission = async () => {
  const missionsDir = path.join(process.cwd(), 'missions');
  const welcomePath = path.join(missionsDir, 'welcome.mission.js');

   // Ensure missions directory exists
  if (!fs.existsSync(missionsDir)) {
    fs.mkdirSync(missionsDir, { recursive: true });
  }

  if (fs.existsSync(welcomePath)) {
    console.log('✅ welcome.mission.js already exists');
    return;
  }

const content = `import { runMissions } from 'testronaut';

export const tags = [];

const welcomeGoal = \`
Welcome to Testronaut!

This is your first mission.
All we ask is that you confirm this setup is working correctly.

To complete this mission, report SUCCESS immediately.
If you cannot reach this message, report FAILURE.
\`;

export async function executeMission() {
  return await runMissions({
    mission: welcomeGoal,
    tags
  }, 'Welcome Mission!');
}

`;

  fs.writeFileSync(welcomePath, content);
  console.log('🚀 Created missions/welcome.mission.js');
}
