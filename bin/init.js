/**
 * Testronaut CLI Initialization
 * -----------------------------
 * Purpose:
 *   Bootstraps a new Testronaut project by creating required folders,
 *   writing a provider/model-aware config, and scaffolding a .env file.
 *
 * Responsibilities:
 *   1) Ask the user for an LLM provider (OpenAI, Gemini, or Anthropic Claude).
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
  anthropicModels,
  pickInitialIndex
} from './initHelpers.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from '../llm/openAI/models.js';
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from '../llm/anthropic/models.js';
import { defaultRateLimitConfig } from '../tools/rateLimitDefaults.js';

const PROVIDERS = [
  { title: 'OpenAI (GPT family)', value: 'openai' },
  { title: 'Google Gemini', value: 'gemini' },
  { title: 'Anthropic Claude', value: 'anthropic' },
];

async function selectProvider(currentProvider = 'openai') {
  const { llmProvider } = await prompts({
    type: 'select',
    name: 'llmProvider',
    message: 'Which LLM provider would you like to use?',
    choices: PROVIDERS,
    initial: Math.max(0, PROVIDERS.findIndex(choice => choice.value === currentProvider)),
  });
  return llmProvider;
}

async function selectModel(provider, currentModel) {
  if (provider === 'openai') {
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
    const selectedIndex = choices.findIndex(choice => choice.value === currentModel);
    const defaultIndex = choices.findIndex(choice => choice.value === DEFAULT_OPENAI_MODEL);
    const { openaiModel } = await prompts({
      type: 'select',
      name: 'openaiModel',
      message: 'Select an OpenAI model for agentic workflows (function/tool calling):',
      choices,
      initial: selectedIndex >= 0 ? selectedIndex : defaultIndex,
    });

    if (openaiModel?.startsWith('gpt-5')) {
      console.log(`
ℹ️  GPT-5 availability and rate limits depend on your OpenAI account and project.
`);
    }
    return openaiModel;
  }

  if (provider === 'gemini') {
    const models = geminiModels();
    const { geminiModel } = await prompts({
      type: 'select',
      name: 'geminiModel',
      message: 'Select a Google Gemini model:',
      choices: [
        { title: 'Gemini 3.8 Flash (latest stable, recommended)', value: 'gemini-3.8-flash' },
        { title: 'Gemini 3.7 Flash (previous stable)', value: 'gemini-3.7-flash' },
        { title: 'Gemini 3.6 Flash (stable, token-efficient)', value: 'gemini-3.6-flash' },
        { title: 'Gemini 3.5 Flash-Lite (fastest, cost-efficient)', value: 'gemini-3.5-flash-lite' },
        { title: 'Gemini 3.1 Pro Preview (complex reasoning)', value: 'gemini-3.1-pro-preview' },
        { title: 'Gemini 2.5 Pro (legacy)', value: 'gemini-2.5-pro' },
        { title: 'Gemini 2.5 Flash (legacy)', value: 'gemini-2.5-flash' },
        { title: 'Gemini 2.5 Flash-Lite (legacy)', value: 'gemini-2.5-flash-lite' },
      ],
      initial: pickInitialIndex(models, currentModel, 'gemini-3.8-flash'),
    });
    return geminiModel;
  }

  if (provider === 'anthropic') {
    const models = anthropicModels();
    const { anthropicModel } = await prompts({
      type: 'select',
      name: 'anthropicModel',
      message: 'Select an Anthropic Claude model:',
      choices: ANTHROPIC_MODELS.map(model => ({
        title: `${model.label} (${model.description})`,
        value: model.id,
      })),
      initial: pickInitialIndex(models, currentModel, DEFAULT_ANTHROPIC_MODEL),
    });
    return anthropicModel;
  }
}

function addSelectedModelRateLimit(config) {
  const defaults = defaultRateLimitConfig(config.provider, config.model);
  config.rateLimits = {
    ...defaults,
    ...(config.rateLimits || {}),
    models: {
      ...(config.rateLimits?.models || {}),
      ...(config.rateLimits?.models?.[config.model]
        ? {}
        : defaults.models),
    },
  };
}

export async function initializeTestronautProject() {
  // ─────────────────────────────────────────────
  // STEP 0: Resolve important paths
  // ─────────────────────────────────────────────
  const root = process.cwd();
  const missionsDir = path.join(root, 'missions');
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
  // STEP 2: Interactive setup
  // ─────────────────────────────────────────────
  if (!config.initialized) {
    // 2a) Provider selection
    const llmProvider = await selectProvider(config.provider);

    // Persist provider explicitly to config.
    config.provider = llmProvider;

    // 2b) Provider-specific model selection
    config.model = await selectModel(llmProvider, config.model);

    // ─────────────────────────────────────────────
    // STEP 3: Merge defaults without clobbering user-provided fields
    // ─────────────────────────────────────────────
    const defaults = defaultConfig(config.projectName || path.basename(root));
    config.initialized = true; // subsequent runs offer focused reconfiguration
    config.outputDir = config.outputDir || defaults.outputDir;
    config.projectName = config.projectName || defaults.projectName;
    config.maxTurns = config.maxTurns ?? defaults.maxTurns;
    config.tags = config.tags ?? defaults.tags;
    config.tagMatch = config.tagMatch ?? defaults.tagMatch;
    config.addTags = config.addTags ?? defaults.addTags;
    config.dom = { ...defaults.dom, ...(config.dom || {}) };
    config.resourceGuard = { ...defaults.resourceGuard, ...(config.resourceGuard || {}) };
    config.humanInput = { ...defaults.humanInput, ...(config.humanInput || {}) };
    addSelectedModelRateLimit(config);

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
    } else if (config.provider === 'anthropic') {
      console.log(`
🔧 Setup Complete!

👉 Ensure your .env file contains your Anthropic key:

    ANTHROPIC_API_KEY=sk-ant-...

✅ Ready to write missions in \`missions/\`. Try:

    testronaut welcome.mission.js
`);
    }

    // Create a small starter mission for a smooth first run.
    createWelcomeMission();
  } else {
    const { reconfigure } = await prompts({
      type: 'select',
      name: 'reconfigure',
      message: `Already initialized with ${config.provider}/${config.model}. What would you like to do?`,
      choices: [
        { title: 'Change model', value: 'model' },
        { title: 'Change provider and model', value: 'provider' },
        { title: 'Keep current settings', value: 'keep' },
      ],
      initial: 0,
    });

    if (reconfigure === 'model' || reconfigure === 'provider') {
      const previousProvider = config.provider;
      const previousModel = config.model;
      const provider = reconfigure === 'provider'
        ? await selectProvider(config.provider)
        : config.provider;
      const model = provider && await selectModel(
        provider,
        provider === previousProvider ? config.model : undefined,
      );

      if (provider && model) {
        config.provider = provider;
        config.model = model;
        addSelectedModelRateLimit(config);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`✅ Updated model: ${previousProvider}/${previousModel} → ${provider}/${model}`);
        if (provider !== previousProvider) {
          console.log(`🔐 Add the ${provider} API key to .env if it is not already present.`);
        }
      } else {
        console.log('↩️  No changes made.');
      }
    } else {
      console.log('↩️  Keeping current settings.');
    }
  }

  // ─────────────────────────────────────────────
  // STEP 5: Ensure folder structure exists (safe to call every run)
  // ─────────────────────────────────────────────
  const reportsDir = path.resolve(root, config.outputDir || 'missions/mission_reports');
  if (!fs.existsSync(missionsDir)) {
    fs.mkdirSync(missionsDir);
    console.log('📁 Created missions/');
  }
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
    console.log(`📁 Created ${path.relative(root, reportsDir) || reportsDir}/`);
  }
}
