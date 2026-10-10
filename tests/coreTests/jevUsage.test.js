import { describe, expect, it } from 'vitest';
import { resolveJevInputPrice, summarizeJevUsage } from '../../core/jevUsage.js';

describe('Jev usage summaries', () => {
  it('aggregates usage, outcomes, gates, latency, and estimated spend', () => {
    const summary = summarizeJevUsage([
      {
        jevShadow: {
          status: 'ok',
          usage: { input_tokens: 1000, output_tokens: 25 },
          latencyMs: 120,
          completionGate: { candidate: true },
          strategies: {
            modelRoute: { choice: 'deterministic' },
            actionChoice: { choice: 'action_1' },
            recovery: { choice: 'continue' },
            missionStage: { choice: 'interact' },
            verification: { noul: 0.9 },
            prerequisite: { noul: 0.85 },
            domRelevance: [{ probability: 0.8 }, { probability: 0.2 }],
          },
        },
        jevGate: { triggered: true },
      },
      { jevShadow: { status: 'error' } },
      { jevShadow: { status: 'skipped' } },
    ], { inputUsdPerMillion: 1 });

    expect(summary).toEqual({
      evaluations: 3,
      completed: 1,
      errors: 1,
      skipped: 1,
      inputTokens: 1000,
      outputTokens: 25,
      latencyMs: 120,
      completionCandidates: 1,
      triggeredCompletions: 1,
      inputUsdPerMillion: 1,
      estimatedInputCostUsd: 0.001,
      strategies: {
        evaluations: 1,
        modelRoutes: { deterministic: 1 },
        actionChoices: { action_1: 1 },
        recoveryRoutes: { continue: 1 },
        missionStages: { interact: 1 },
        verifiedPostconditions: 1,
        satisfiedPrerequisites: 1,
        regionsEvaluated: 2,
        relevantRegions: 1,
      },
    });
  });

  it('supports a configured input price', () => {
    expect(resolveJevInputPrice({ TESTRONAUT_JEV_INPUT_USD_PER_MILLION: '0.05' })).toBe(0.05);
  });
});
