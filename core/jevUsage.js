export const DEFAULT_JEV_INPUT_USD_PER_MILLION = 0.042;

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function resolveJevInputPrice(env = process.env) {
  return nonNegativeNumber(
    env.TESTRONAUT_JEV_INPUT_USD_PER_MILLION,
    DEFAULT_JEV_INPUT_USD_PER_MILLION,
  );
}

export function summarizeJevUsage(steps = [], {
  inputUsdPerMillion = resolveJevInputPrice(),
} = {}) {
  const entries = (Array.isArray(steps) ? steps : [])
    .map(step => step?.jevShadow)
    .filter(Boolean);
  const completed = entries.filter(entry => entry.status === 'ok');
  const inputTokens = completed.reduce(
    (sum, entry) => sum + nonNegativeNumber(entry.usage?.input_tokens),
    0,
  );
  const outputTokens = completed.reduce(
    (sum, entry) => sum + nonNegativeNumber(entry.usage?.output_tokens),
    0,
  );
  const strategyEntries = completed.map(entry => entry.strategies).filter(Boolean);
  const countChoices = (values) => values.reduce((counts, value) => {
    if (value) counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
  const regionDecisions = strategyEntries.flatMap(entry => entry.domRelevance || []);

  return {
    evaluations: entries.length,
    completed: completed.length,
    errors: entries.filter(entry => entry.status === 'error').length,
    skipped: entries.filter(entry => entry.status === 'skipped').length,
    inputTokens,
    outputTokens,
    latencyMs: completed.reduce((sum, entry) => sum + nonNegativeNumber(entry.latencyMs), 0),
    completionCandidates: completed.filter(entry => entry.completionGate?.candidate).length,
    triggeredCompletions: (Array.isArray(steps) ? steps : [])
      .filter(step => step?.jevGate?.triggered).length,
    inputUsdPerMillion,
    estimatedInputCostUsd: inputTokens * inputUsdPerMillion / 1_000_000,
    strategies: strategyEntries.length ? {
      evaluations: strategyEntries.length,
      modelRoutes: countChoices(strategyEntries.map(entry => entry.modelRoute?.choice)),
      actionChoices: countChoices(strategyEntries.map(entry => entry.actionChoice?.choice)),
      recoveryRoutes: countChoices(strategyEntries.map(entry => entry.recovery?.choice)),
      missionStages: countChoices(strategyEntries.map(entry => entry.missionStage?.choice)),
      verifiedPostconditions: strategyEntries.filter(entry => Number(entry.verification?.noul) >= 0.8).length,
      satisfiedPrerequisites: strategyEntries.filter(entry => Number(entry.prerequisite?.noul) >= 0.8).length,
      regionsEvaluated: regionDecisions.length,
      relevantRegions: regionDecisions.filter(region => Number(region.probability) >= 0.5).length,
    } : null,
  };
}
