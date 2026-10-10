import { describe, expect, it } from 'vitest';
import { chooseJevTurnModel, resolveJevRoutingConfig } from '../../core/jevRouting.js';

const safeFastRoute = {
  modelRoute: { choice: 'fast_model', confidence: 0.22, probabilities: { fast_model: 0.52 } },
  missionStage: { choice: 'interact' },
  recovery: { choice: 'continue' },
};

describe('Jev dynamic routing', () => {
  it('defaults OpenAI experiments to Luna without enabling routing', () => {
    expect(resolveJevRoutingConfig({}, {
      provider: 'openai', primaryModel: 'gpt-5.6-terra',
    })).toMatchObject({ mode: 'off', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.4 });
  });

  it.each([
    ['gemini', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    ['anthropic', 'claude-sonnet-5', 'claude-haiku-4-5'],
  ])('keeps the default fast model within the %s family', (provider, primaryModel, fastModel) => {
    expect(resolveJevRoutingConfig({}, { provider, primaryModel })).toMatchObject({ fastModel });
  });

  it('records an eligible route without applying it in shadow mode', () => {
    const result = chooseJevTurnModel(safeFastRoute, {
      mode: 'shadow', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.4,
    }, { provider: 'openai', primaryModel: 'gpt-5.6-terra' });
    expect(result).toMatchObject({ eligible: true, applied: false, selectedModel: 'gpt-5.6-terra', reason: 'shadow_only' });
  });

  it('applies a high-confidence fast route for one live turn', () => {
    const result = chooseJevTurnModel(safeFastRoute, {
      mode: 'live', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.4,
    }, { provider: 'openai', primaryModel: 'gpt-5.6-terra' });
    expect(result).toMatchObject({ eligible: true, applied: true, selectedModel: 'gpt-5.6-luna', reason: 'jev_fast_model', score: 0.52, confidence: 0.22 });
  });

  it.each([
    [{ ...safeFastRoute, missionStage: { choice: 'authenticate' } }, 'stage_authenticate'],
    [{ ...safeFastRoute, recovery: { choice: 'reobserve' } }, 'recovery_reobserve'],
    [{ ...safeFastRoute, modelRoute: { choice: 'fast_model', confidence: 0.5, probabilities: { fast_model: 0.39 } } }, 'low_probability'],
  ])('keeps sensitive or uncertain turns on the primary model', (strategy, reason) => {
    expect(chooseJevTurnModel(strategy, {
      mode: 'live', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.4,
    }, { provider: 'openai', primaryModel: 'gpt-5.6-terra' })).toMatchObject({ applied: false, reason });
  });

  it('rejects a configured model from another provider family', () => {
    expect(chooseJevTurnModel(safeFastRoute, {
      mode: 'live', fastModel: 'gpt-5.6-luna', confidenceThreshold: 0.4,
    }, { provider: 'gemini', primaryModel: 'gemini-3.8-flash' })).toMatchObject({
      applied: false,
      reason: 'fast_model_provider_mismatch',
      selectedModel: 'gemini-3.8-flash',
    });
  });
});
