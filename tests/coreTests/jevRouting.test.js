import { describe, expect, it } from 'vitest';
import { chooseJevTurnModel, resolveJevRoutingConfig } from '../../core/jevRouting.js';

const safeFastRoute = {
  modelRoute: { choice: 'fast_model', confidence: 0.92 },
  missionStage: { choice: 'interact' },
  recovery: { choice: 'continue' },
};

describe('Jev dynamic routing', () => {
  it('defaults OpenAI experiments to Luna without enabling routing', () => {
    expect(resolveJevRoutingConfig({}, {
      provider: 'openai', primaryModel: 'gpt-5.6-terra',
    })).toMatchObject({ mode: 'off', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.8 });
  });

  it('records an eligible route without applying it in shadow mode', () => {
    const result = chooseJevTurnModel(safeFastRoute, {
      mode: 'shadow', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.8,
    }, { provider: 'openai', primaryModel: 'gpt-5.6-terra' });
    expect(result).toMatchObject({ eligible: true, applied: false, selectedModel: 'gpt-5.6-terra', reason: 'shadow_only' });
  });

  it('applies a high-confidence fast route for one live turn', () => {
    const result = chooseJevTurnModel(safeFastRoute, {
      mode: 'live', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.8,
    }, { provider: 'openai', primaryModel: 'gpt-5.6-terra' });
    expect(result).toMatchObject({ eligible: true, applied: true, selectedModel: 'gpt-5.6-luna', reason: 'jev_fast_model' });
  });

  it.each([
    [{ ...safeFastRoute, missionStage: { choice: 'authenticate' } }, 'stage_authenticate'],
    [{ ...safeFastRoute, recovery: { choice: 'reobserve' } }, 'recovery_reobserve'],
    [{ ...safeFastRoute, modelRoute: { choice: 'fast_model', confidence: 0.5 } }, 'low_confidence'],
  ])('keeps sensitive or uncertain turns on the primary model', (strategy, reason) => {
    expect(chooseJevTurnModel(strategy, {
      mode: 'live', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.8,
    }, { provider: 'openai', primaryModel: 'gpt-5.6-terra' })).toMatchObject({ applied: false, reason });
  });
});
