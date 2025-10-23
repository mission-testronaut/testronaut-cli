import path from 'path';
import fs from 'fs';

const root = process.cwd();
const configPath = path.join(root, 'testronaut-config.json');

/**
 * Resolves provider & model with env overrides and safe defaults.
 * Env has highest priority:
 *   - TESTRONAUT_PROVIDER
 *   - TESTRONAUT_MODEL
 */
export function resolveProviderModel() {
  const envProvider = process.env.TESTRONAUT_PROVIDER?.trim();
  const envModel    = process.env.TESTRONAUT_MODEL?.trim();

  if (envProvider && envModel) {
    return { provider: envProvider, model: envModel };
  }

  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Preferred path: explicit provider & model in config
      if (cfg?.provider && cfg?.model) {
        return {
          provider: envProvider || cfg.provider,
          model: envModel || cfg.model,
        };
      }

      // Back-compat: very old configs with 'openai' in model
      if (!cfg?.provider && cfg?.model === 'openai') {
        return { provider: 'openai', model: envModel || 'gpt-4o' };
      }
    }
  } catch (e) {
    console.warn('⚠️ Could not read testronaut-config.json; using default provider/model. Error:', e.message);
  }

  // Safe defaults
  return {
    provider: envProvider || 'openai',
    model: envModel || 'gpt-4o',
  };
}
