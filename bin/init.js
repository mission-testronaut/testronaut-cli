import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import { createWelcomeMission } from './createWelcomeMission.js';

export async function initializeTestronautProject() {
  const root = process.cwd();
  const missionsDir = path.join(root, 'missions');
  const reportsDir = path.join(missionsDir, 'mission_reports');
  const configPath = path.join(root, 'testronaut-config.json');
  const envPath = path.join(root, '.env');

  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  // If not initialized before, walk through setup
  if (!config.initialized) {
    // Prompt for LLM
    const response = await prompts({
      type: 'select',
      name: 'llmProvider',
      message: 'Which LLM provider would you like to use?',
      choices: [
        { title: 'OpenAI (GPT-4o)', value: 'openai' },
        // Add others like Anthropic, Mistral, etc. later
      ]
    });

    config.model = response.llmProvider;
    config.initialized = true;
    config.outputDir = 'missions/mission_reports';
    config.projectName = path.basename(root);
    config.maxTurns = 20;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('📝 Created testronaut-config.json');

    if (response.llmProvider === 'openai') {
      // Display .env instructions
      if (!fs.existsSync(envPath)) {
        const exampleEnv = `# Add your OpenAI API key below\nOPENAI_API_KEY=sk-...\n`;
        fs.writeFileSync(envPath, exampleEnv);
        console.log('🔐 Created .env file');
      }

      console.log(`
🔧 Setup Complete!

👉 Please ensure your .env file contains your OpenAI API key like this:

    OPENAI_API_KEY=sk-...

📌 The key must have permissions to call the OpenAI Chat Completions API.

✅ You’re now ready to write missions in \`missions/\` and run your first mission using:

    testronaut welcome.mission.js
`);
    }

    createWelcomeMission();
  } else {
    console.log('🔁 Already initialized. Skipping setup.');
  }

  // Create directories if they don't exist
  if (!fs.existsSync(missionsDir)) {
    fs.mkdirSync(missionsDir);
    console.log('📁 Created missions/');
  }

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
    console.log('📁 Created missions/mission_reports/');
  }
}
