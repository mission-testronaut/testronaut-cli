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

    // --- Back-compat migration: old configs stored provider in `model`
    if (!config.provider && config.model === 'openai') {
      config.provider = 'openai';
      // don't overwrite model yet; we'll re-ask below only if not initialized
    }
  }

  // If not initialized before, walk through setup
  if (!config.initialized) {
    // 1) Provider
    const { llmProvider } = await prompts({
      type: 'select',
      name: 'llmProvider',
      message: 'Which LLM provider would you like to use?',
      choices: [
        { title: 'OpenAI (GPT family)', value: 'openai' },
        // Add others like Anthropic, Mistral, etc. later
      ]
    });

    config.provider = llmProvider; // store provider explicitly

    // 2) If OpenAI, ask for model
    const { openaiModel } = await prompts({
      type: 'select',
      name: 'openaiModel',
      message: 'Select an OpenAI model for agentic workflows (function/tool calling):',
      choices: [
        { title: 'GPT-4.1 (general purpose)', value: 'gpt-4.1' },
        { title: 'GPT-4.1 mini (faster, cheaper)', value: 'gpt-4.1-mini' },
        { title: 'GPT-4o (multimodal, tool use)', value: 'gpt-4o' },
        { title: 'GPT-4o mini (speed/cost optimized)', value: 'gpt-4o-mini' },
        { title: 'o3 (reasoning w/ native tool use)', value: 'o3' },
        { title: 'o4-mini (reasoning, cost-effective)', value: 'o4-mini' },

        // 👇 GPT-5 family
        { title: 'GPT-5 (latest reasoning model)', value: 'gpt-5' },
        { title: 'GPT-5 mini (faster)', value: 'gpt-5-mini' },
        { title: 'GPT-5 nano (lightweight)', value: 'gpt-5-nano' },
      ],
      initial: 1
    });

    config.model = openaiModel;

    // Warn about GPT-5 availability
    if (openaiModel.startsWith('gpt-5')) {
      console.log(`
    ⚠️  Warning: GPT-5 support may not be available for all users.
      - Access depends on your OpenAI account/region
      - Some capabilities may be gated or rate-limited
      `);
    }

    // Default config fields
    config.initialized = true;
    config.outputDir = config.outputDir || 'missions/mission_reports';
    config.projectName = config.projectName || path.basename(root);
    config.maxTurns = config.maxTurns ?? 20;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('📝 Created testronaut-config.json');

    if (llmProvider === 'openai') {
      // Display .env instructions for OpenAI
      if (!fs.existsSync(envPath)) {
        const exampleEnv = `# Add your OpenAI API key below
OPENAI_API_KEY=sk-...
`;
        fs.writeFileSync(envPath, exampleEnv);
        console.log('🔐 Created .env file');
      }

      console.log(`
🔧 Setup Complete!

👉 Please ensure your .env file contains your OpenAI API key like this:

    OPENAI_API_KEY=sk-...

📌 The key must have permissions to call the OpenAI API.

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
