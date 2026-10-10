const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

function probability(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function resolveJevRoutingConfig(env = process.env, { provider, primaryModel } = {}) {
  const rawMode = String(env.TESTRONAUT_JEV_ROUTING || 'off').trim().toLowerCase();
  const mode = ['shadow', 'live'].includes(rawMode) ? rawMode : 'off';
  const providerKey = String(provider).toLowerCase();
  const familyDefault = {
    openai: 'gpt-5.6-luna',
    gemini: 'gemini-3.5-flash-lite',
    anthropic: 'claude-haiku-4-5',
    claude: 'claude-haiku-4-5',
  }[providerKey] || '';
  const defaultFastModel = primaryModel === familyDefault ? '' : familyDefault;
  return {
    mode,
    fastModel: String(env.TESTRONAUT_JEV_FAST_MODEL || defaultFastModel).trim(),
    confidenceThreshold: probability(
      env.TESTRONAUT_JEV_ROUTING_THRESHOLD,
      DEFAULT_CONFIDENCE_THRESHOLD,
    ),
  };
}

function belongsToProvider(model, provider) {
  const value = String(model || '').toLowerCase();
  switch (String(provider || '').toLowerCase()) {
    case 'openai': return /^(gpt-|o\d)/.test(value);
    case 'gemini': return value.startsWith('gemini-');
    case 'anthropic':
    case 'claude': return value.startsWith('claude-');
    default: return true;
  }
}

export function chooseJevTurnModel(strategy, config, { provider, primaryModel } = {}) {
  const route = strategy?.modelRoute;
  const score = Number(route?.probabilities?.fast_model);
  const confidence = Number(route?.confidence);
  const recommendation = route?.choice || null;
  const stage = strategy?.missionStage?.choice || null;
  const recovery = strategy?.recovery?.choice || null;
  const blockedReason =
    config.mode === 'off' ? 'routing_off' :
    recommendation !== 'fast_model' ? 'not_fast_model' :
    !config.fastModel ? 'fast_model_unconfigured' :
    !belongsToProvider(config.fastModel, provider) ? 'fast_model_provider_mismatch' :
    config.fastModel === primaryModel ? 'fast_model_matches_primary' :
    !Number.isFinite(score) || score < config.confidenceThreshold ? 'low_probability' :
    ['authenticate', 'failed', 'complete'].includes(stage) ? `stage_${stage}` :
    (recovery && recovery !== 'continue') ? `recovery_${recovery}` :
    null;
  const eligible = !blockedReason;
  const applied = eligible && config.mode === 'live';

  return {
    mode: config.mode,
    provider,
    primaryModel,
    fastModel: config.fastModel || null,
    selectedModel: applied ? config.fastModel : primaryModel,
    recommendation,
    confidence: Number.isFinite(confidence) ? confidence : null,
    score: Number.isFinite(score) ? score : null,
    scoreType: 'fast_model_probability',
    threshold: config.confidenceThreshold,
    eligible,
    applied,
    reason: blockedReason || (applied ? 'jev_fast_model' : 'shadow_only'),
  };
}

export const __jevRoutingInternals = { DEFAULT_CONFIDENCE_THRESHOLD, probability, belongsToProvider };
