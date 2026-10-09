export const OPTIMIZATION_OBJECTIVES = ['off', 'cost', 'tokens', 'balanced', 'speed'];
export const OPTIMIZATION_MODES = ['off', 'shadow', 'live'];

const OBJECTIVE_ALIASES = {
  neither: 'off',
  'lower-spend': 'cost',
  spend: 'cost',
  'fewer-tokens': 'tokens',
  both: 'balanced',
  latency: 'speed',
};

function normalize(value, allowed, aliases = {}) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const resolved = aliases[normalized] || normalized;
  return allowed.includes(resolved) ? resolved : null;
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

export function resolveOptimizationPolicy({ env = process.env, config = {} } = {}) {
  const configValue = config.optimization || {};
  const rawObjective = env.TESTRONAUT_OPTIMIZE ?? configValue.objective;
  const rawMode = env.TESTRONAUT_OPTIMIZATION_MODE ?? configValue.mode;
  const objective = normalize(rawObjective, OPTIMIZATION_OBJECTIVES, OBJECTIVE_ALIASES);
  const mode = normalize(rawMode, OPTIMIZATION_MODES);
  const configured = rawObjective !== undefined || rawMode !== undefined;
  const effectiveObjective = objective ?? (configured ? 'off' : null);
  const effectiveMode = mode ?? (configured && effectiveObjective !== 'off' ? 'shadow' : 'off');
  const routingRequested = ['cost', 'balanced', 'speed'].includes(effectiveObjective);
  const betaModelRouting = truthy(
    env.TESTRONAUT_BETA_MODEL_ROUTING ?? configValue.beta?.modelRouting,
  );
  const threshold = Number(
    env.TESTRONAUT_JEV_ROUTING_THRESHOLD
      ?? configValue.guardrails?.minimumRoutingProbability,
  );

  return {
    configured,
    objective: effectiveObjective,
    mode: effectiveObjective === 'off' ? 'off' : effectiveMode,
    routingRequested,
    betaModelRouting,
    routing: routingRequested && betaModelRouting,
    tokenReduction: ['tokens', 'balanced'].includes(effectiveObjective),
    completionGate: effectiveMode === 'live' && effectiveObjective !== 'off',
    routingProbability: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
      ? threshold
      : 0.4,
    completionProbability: (() => {
      const value = Number(
        env.TESTRONAUT_JEV_GATE_THRESHOLD
          ?? configValue.guardrails?.completionProbability,
      );
      return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.8;
    })(),
    valid: (!configured || Boolean(objective || rawObjective === undefined))
      && (rawMode === undefined || Boolean(mode)),
  };
}

export function applyOptimizationPolicy(policy, env = process.env, { force = false } = {}) {
  if (!policy?.configured) return env;
  env.TESTRONAUT_OPTIMIZATION_OBJECTIVE_EFFECTIVE = policy.objective;
  env.TESTRONAUT_OPTIMIZATION_MODE_EFFECTIVE = policy.mode;
  if (force || env.TESTRONAUT_JEV_ROUTING_THRESHOLD === undefined) {
    env.TESTRONAUT_JEV_ROUTING_THRESHOLD = String(policy.routingProbability);
  }
  if (force || env.TESTRONAUT_JEV_GATE_THRESHOLD === undefined) {
    env.TESTRONAUT_JEV_GATE_THRESHOLD = String(policy.completionProbability);
  }
  if (force || env.TESTRONAUT_JEV_ROUTING === undefined) {
    env.TESTRONAUT_JEV_ROUTING = policy.routing ? policy.mode : 'off';
  }
  if (force || env.TESTRONAUT_JEV_GATE === undefined) {
    env.TESTRONAUT_JEV_GATE = policy.completionGate ? '1' : '0';
  }
  if (force || env.TESTRONAUT_JEV_STRATEGIES === undefined) {
    env.TESTRONAUT_JEV_STRATEGIES = policy.routing ? '1' : '0';
  }
  if (force || env.TESTRONAUT_JEV_SHADOW === undefined) {
    env.TESTRONAUT_JEV_SHADOW = policy.mode === 'off' ? '0' : '1';
  }
  return env;
}

export const __optimizationInternals = { normalize, OBJECTIVE_ALIASES };
