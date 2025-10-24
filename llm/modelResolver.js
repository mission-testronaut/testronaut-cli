/**
 * modelResolver.js
 * -----------------
 * Purpose:
 *   Determines which LLM provider and model Testronaut should use.
 *   Reads from env first, then `testronaut-config.json`, then defaults.
 *
 * Resolution priority:
 *   1) Env: TESTRONAUT_PROVIDER / TESTRONAUT_MODEL
 *   2) Config file (provider + model)
 *   3) Legacy config (model === "openai", no provider)
 *   4) Default: { provider: "openai", model: "gpt-4o" }
 *
 * Related tests: tests/llmTests/modelResolver.test.js
 * Used by: core/turnLoop.js, llm/llmFactory.js
 */

import path from 'path';
import fs from 'fs';

/**
 * Resolve provider & model, honoring env overrides and safe defaults.
 * @param {{cwd?: string}} [opts] - optional current working directory override (useful in tests)
 * @returns {{provider: string, model: string}}
 */
export function resolveProviderModel(opts = {}) {
  const envProvider = process.env.TESTRONAUT_PROVIDER?.trim();
  const envModel    = process.env.TESTRONAUT_MODEL?.trim();

  // 1) Env override (both provided)
  if (envProvider && envModel) {
    return { provider: envProvider, model: envModel };
  }

  // 2) Config lookup (compute path at call time)
  const root = opts.cwd || process.cwd();
  const configPath = path.join(root, 'testronaut-config.json');

  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Modern config: explicit provider + model
      if (cfg?.provider && cfg?.model) {
        return {
          provider: envProvider || cfg.provider,
          model: envModel || cfg.model,
        };
      }

      // Legacy: model === "openai" and no provider
      if (!cfg?.provider && cfg?.model === 'openai') {
        return { provider: 'openai', model: envModel || 'gpt-4o' };
      }
    }
  } catch (e) {
    console.warn('⚠️ Could not read testronaut-config.json; using defaults. Error:', e.message);
  }

  // 3) Defaults
  return {
    provider: envProvider || 'openai',
    model: envModel || 'gpt-4o',
  };
}
