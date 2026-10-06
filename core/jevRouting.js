const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

function probability(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function resolveJevRoutingConfig(env = process.env, { provider, primaryModel } = {}) {
  const rawMode = String(env.TESTRONAUT_JEV_ROUTING || 'off').trim().toLowerCase();
  const mode = ['shadow', 'live'].includes(rawMode) ? rawMode : 'off';
  const defaultFastModel = String(provider).toLowerCase() === 'openai' && primaryModel !== 'gpt-5.6-luna'
    ? 'gpt-5.6-luna'
    : '';
  return {
    mode,
    fastModel: String(env.TESTRONAUT_JEV_FAST_MODEL || defaultFastModel).trim(),
    confidenceThreshold: probability(
      env.TESTRONAUT_JEV_ROUTING_THRESHOLD,
      DEFAULT_CONFIDENCE_THRESHOLD,
    ),
  };
}

export function chooseJevTurnModel(strategy, config, { provider, primaryModel } = {}) {
  const route = strategy?.modelRoute;
  const confidence = Number(route?.confidence ?? route?.probabilities?.fast_model);
  const recommendation = route?.choice || null;
  const stage = strategy?.missionStage?.choice || null;
  const recovery = strategy?.recovery?.choice || null;
  const blockedReason =
    config.mode === 'off' ? 'routing_off' :
    recommendation !== 'fast_model' ? 'not_fast_model' :
    !config.fastModel ? 'fast_model_unconfigured' :
    config.fastModel === primaryModel ? 'fast_model_matches_primary' :
    !Number.isFinite(confidence) || confidence < config.confidenceThreshold ? 'low_confidence' :
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
    threshold: config.confidenceThreshold,
    eligible,
    applied,
    reason: blockedReason || (applied ? 'jev_fast_model' : 'shadow_only'),
  };
}

export const __jevRoutingInternals = { DEFAULT_CONFIDENCE_THRESHOLD, probability };
