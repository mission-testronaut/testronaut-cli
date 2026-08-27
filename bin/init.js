/**
 * Testronaut CLI Initialization
 * -----------------------------
 * Purpose:
 *   Bootstraps a new Testronaut project by creating required folders,
 *   writing a provider/model-aware config, and scaffolding a .env file.
 *
 * Responsibilities:
 *   1) Ask the user for an LLM provider (OpenAI or Gemini).
 *   2) Ask for a provider-specific model (keeps prior choice when re-run).
 *   3) Write `testronaut-config.json` and an initial `.env` placeholder.
 *   4) Ensure folder structure and create a welcome mission.
 *
 * Side effects:
 *   - Writes files to disk: `testronaut-config.json`, `.env`,
 *     `missions/`, `missions/mission_reports/`.
 *   - Calls `createWelcomeMission()` on first init.
 *
 * Developer notes:
 *   - Extend provider support by adding a new provider choice here and
 *     updating `initHelpers.js` (model list + template).
 *   - Keep this file orchestration-only; pure logic lives in helpers
 *     (which are unit-tested).
 */

import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import { createWelcomeMission } from './createWelcomeMission.js';

import {
  migrateLegacyConfig,
  defaultConfig,
  makeEnvTemplate,
  geminiModels,
  pickInitialIndex
} from './initHelpers.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from '../llm/openAI/models.js';

export async function initializeTestronautProject() {
  // ─────────────────────────────────────────────
  // STEP 0: Resolve important paths
  // ─────────────────────────────────────────────
  const root = process.cwd();
  const missionsDir = path.join(root, 'missions');
  const reportsDir = path.join(missionsDir, 'mission_reports');
  const configPath = path.join(root, 'testronaut-config.json');
  const envPath = path.join(root, '.env');

  // ─────────────────────────────────────────────
  // STEP 1: Load existing config (if any) and normalize
  // ─────────────────────────────────────────────
  /** @type {any} */
  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Normalize legacy structures (e.g., provider implied by model).
    config = migrateLegacyConfig(config);
  }

  // ─────────────────────────────────────────────
  // STEP 2: Interactive setup (first run only)
  // ─────────────────────────────────────────────
  if (!config.initialized) {
    // 2a) Provider selection
    const { llmProvider } = await prompts({
      type: 'select',
      name: 'llmProvider',
      message: 'Which LLM provider would you like to use?',
      choices: [
        { title: 'OpenAI (GPT family)', value: 'openai' },
        { title: 'Google Gemini', value: 'gemini' },
        // Future: add Anthropic, Mistral, etc.
      ],
      // If user re-runs init before writing config, preselect known value.
      initial: ['openai', 'gemini'].indexOf(config.provider ?? 'openai')
    });

    // Persist provider explicitly to config.
    config.provider = llmProvider;

    // 2b) Provider-specific model selection
    if (llmProvider === 'openai') {
      const currentModels = OPENAI_MODELS.filter(model => !model.legacy);
      const legacyModels = OPENAI_MODELS.filter(model => model.legacy);
      const choices = [
        ...currentModels.map(model => ({
          title: `${model.label} (${model.description})`,
          value: model.id,
        })),
        { title: '── Legacy models ──', disabled: true },
        ...legacyModels.map(model => ({
          title: `${model.label} (${model.description})`,
          value: model.id,
        })),
      ];
      const selectedIndex = choices.findIndex(choice => choice.value === config.model);
      const defaultIndex = choices.findIndex(choice => choice.value === DEFAULT_OPENAI_MODEL);
      const { openaiModel } = await prompts({
        type: 'select',
        name: 'openaiModel',
        message: 'Select an OpenAI model for agentic workflows (function/tool calling):',
        choices,
        // Keep a prior selection highlighted; otherwise default to GPT-5.6.
        initial: selectedIndex >= 0 ? selectedIndex : defaultIndex,
      });

      config.model = openaiModel;

      // API access and rate limits vary by OpenAI account and project.
      if (openaiModel?.startsWith('gpt-5')) {
        console.log(`
ℹ️  GPT-5 availability and rate limits depend on your OpenAI account and project.
`);
      }
    } else if (llmProvider === 'gemini') {
      const models = geminiModels();
      const { geminiModel } = await prompts({
        type: 'select',
        name: 'geminiModel',
        message: 'Select a Google Gemini model:',
        choices: [
          { title: 'Gemini 2.5 Pro (general, high quality)', value: 'gemini-2.5-pro' },
          { title: 'Gemini 2.5 Flash (fast, cost-efficient)', value: 'gemini-2.5-flash' },
          { title: 'Gemini 2.5 Flash-8B (lightweight)', value: 'gemini-2.5-flash-8b' },
        ],
        // Keep prior selection if present; default to fast/cost-effective Flash.
        initial: pickInitialIndex(models, config.model, 'gemini-2.5-flash')
      });

      config.model = geminiModel;
    }

    // ─────────────────────────────────────────────
    // STEP 3: Merge defaults without clobbering user-provided fields
    // ─────────────────────────────────────────────
    const defaults = defaultConfig(config.projectName || path.basename(root));
    config.initialized = true; // mark as initialized so subsequent runs skip prompts
    config.outputDir = config.outputDir || defaults.outputDir;
    config.projectName = config.projectName || defaults.projectName;
    config.maxTurns = config.maxTurns ?? defaults.maxTurns;
    config.dom = { ...defaults.dom, ...(config.dom || {}) };
    config.resourceGuard = { ...defaults.resourceGuard, ...(config.resourceGuard || {}) };
    config.humanInput = { ...defaults.humanInput, ...(config.humanInput || {}) };

    // ─────────────────────────────────────────────
    // STEP 4: Persist config and scaffold .env (first run only)
    // ─────────────────────────────────────────────
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('📝 Created testronaut-config.json');

    // Only create .env if it doesn't exist to avoid overwriting secrets.
    if (!fs.existsSync(envPath)) {
      const exampleEnv = makeEnvTemplate(config.provider);
      if (exampleEnv) {
        fs.writeFileSync(envPath, exampleEnv);
        console.log('🔐 Created .env file');
      }
    }

    // Provider-specific post-setup messages: quick path to first run.
    if (config.provider === 'openai') {
      console.log(`
🔧 Setup Complete!

👉 Ensure your .env file contains your OpenAI key:

    OPENAI_API_KEY=sk-...

✅ Ready to write missions in \`missions/\`. Try:

    testronaut welcome.mission.js
`);
    } else if (config.provider === 'gemini') {
      console.log(`
🔧 Setup Complete!

👉 Ensure your .env file contains your Gemini key:

    GEMINI_API_KEY=AIza...

📌 If you plan to use tools/function-calling or images, make sure your account has access to those features.

✅ Ready to write missions in \`missions/\`. Try:

    testronaut welcome.mission.js
`);
    }

    // Create a small starter mission for a smooth first run.
    createWelcomeMission();
  } else {
    // Already initialized: keep init idempotent and non-destructive.
    console.log('🔁 Already initialized. Skipping setup.');
  }

  // ─────────────────────────────────────────────
  // STEP 5: Ensure folder structure exists (safe to call every run)
  // ─────────────────────────────────────────────
  if (!fs.existsSync(missionsDir)) {
    fs.mkdirSync(missionsDir);
    console.log('📁 Created missions/');
  }
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
    console.log('📁 Created missions/mission_reports/');
  }
}
