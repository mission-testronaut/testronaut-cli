import path from 'path';
import fs from 'fs';

// Resolve model from config (or ENV) with safe fallback
const root = process.cwd();
const configPath = path.join(root, 'testronaut-config.json');

export function resolveModel() {
  // Highest priority: env override
  if (process.env.TESTRONAUT_MODEL?.trim()) {
    return process.env.TESTRONAUT_MODEL.trim();
  }

  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // Only use the model if provider is openai (future-proofing for other providers)
      if (cfg?.provider === 'openai' && typeof cfg?.model === 'string' && cfg.model.trim()) {
        return cfg.model.trim();
      }
      // Back-compat: older configs may have stored 'openai' in model
      if (!cfg?.provider && cfg?.model === 'openai') {
        return 'gpt-4o';
      }
    }
  } catch (e) {
    console.warn('⚠️ Could not read testronaut-config.json; using default model. Error:', e.message);
  }

  return 'gpt-4o';
}


