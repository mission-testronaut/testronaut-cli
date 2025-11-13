/**
 * initHelpers.js
 * ---------------
 * Purpose:
 *   Collection of pure, unit-testable helper functions used by the Testronaut
 *   CLI initialization process. These handle config normalization, defaults,
 *   provider-specific templates, and list-based selections.
 *
 * Design goals:
 *   - No side effects (no file system or prompts)
 *   - All logic easily testable via Vitest
 *
 * Related tests:
 *   Located in `tests/binTests/`
 *   Each helper has corresponding unit tests (e.g., `migrateLegacyConfig.test.js`,
 *   `makeEnvTemplate.test.js`, `pickInitialIndex.test.js`) that validate expected
 *   behavior and regression safety.
 *
 * Used by:
 *   ./init.js
 *
 * Example usage:
 *   const defaults = defaultConfig(path.basename(process.cwd()));
 *   const envTemplate = makeEnvTemplate('gemini');
 *   const models = openAIModels();
 */

/**
 * Ensures backward compatibility for older configs where
 * provider information may have been implied by the model field.
 *
 * @param {object} cfg - Parsed testronaut-config.json object
 * @returns {object} - Updated config with normalized provider field
 */
export function migrateLegacyConfig(cfg) {
  const out = { ...cfg };
  if (!out.provider && out.model === 'openai') {
    out.provider = 'openai';
  }
  return out;
}

/**
 * Generates default configuration values for a new project.
 *
 * @param {string} rootBasename - Name of the current working directory
 * @returns {{initialized: boolean, outputDir: string, projectName: string, maxTurns: number}}
 */
export function defaultConfig(rootBasename) {
  return {
    initialized: true,
    outputDir: 'missions/mission_reports',
    projectName: rootBasename,
    maxTurns: 20,
  };
}

/**
 * Returns a provider-specific .env template string.
 * This scaffolds a safe placeholder API key for the user to fill in manually.
 *
 * @param {'openai'|'gemini'} provider - The chosen LLM provider
 * @returns {string} A multiline template for the .env file
 */
export function makeEnvTemplate(provider) {
  if (provider === 'openai') {
    return `# Add your OpenAI API key below
OPENAI_API_KEY=sk-...
`;
  }
  if (provider === 'gemini') {
    return `# Add your Google Gemini API key below
GEMINI_API_KEY=AIza...
`;
  }
  return '';
}

/**
 * List of supported OpenAI model identifiers.
 *
 * @returns {string[]} Array of OpenAI model names
 */
export function openAIModels() {
  return [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o4-mini',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5.1',
  ];
}

/**
 * List of supported Google Gemini model identifiers.
 *
 * @returns {string[]} Array of Gemini model names
 */
export function geminiModels() {
  return [
    'gemini-2.5-pro',        // best reasoning, tool use
    'gemini-2.5-flash',      // fast, cost-effective
    'gemini-2.5-flash-lite', // lightweight / high throughput
  ];
}

/**
 * Determines whether a given model name belongs to a known provider.
 *
 * @param {'openai'|'gemini'} provider - The LLM provider
 * @param {string} model - The model name to check
 * @returns {boolean} True if the model is recognized for that provider
 */
export function isKnownModel(provider, model) {
  return provider === 'openai'
    ? openAIModels().includes(model)
    : geminiModels().includes(model);
}

/**
 * Finds the initial selection index for a list-based UI (e.g. prompts.js select).
 * Prefers the current value if found, otherwise falls back to a known default,
 * and finally to the first item if neither is present.
 *
 * @template T
 * @param {T[]} list - Array of available options
 * @param {T} current - Currently selected value (if any)
 * @param {T} fallback - Fallback value if current is missing
 * @returns {number} The index to use as `initial` in a selection prompt
 */
export function pickInitialIndex(list, current, fallback) {
  const idx = list.indexOf(current);
  if (idx >= 0) return idx;
  const fb = list.indexOf(fallback);
  return fb >= 0 ? fb : 0;
}
