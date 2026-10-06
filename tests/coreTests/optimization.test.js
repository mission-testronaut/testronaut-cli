import { describe, expect, it } from 'vitest';
import { applyOptimizationPolicy, resolveOptimizationPolicy } from '../../core/optimization.js';

describe('optimization policy', () => {
  it.each([
    ['off', false, false],
    ['cost', true, false],
    ['tokens', false, true],
    ['balanced', true, true],
    ['speed', true, false],
  ])('maps %s to implemented capabilities', (objective, routing, tokenReduction) => {
    expect(resolveOptimizationPolicy({
      env: {}, config: { optimization: { objective, mode: 'live' } },
    })).toMatchObject({ objective, mode: objective === 'off' ? 'off' : 'live', routing, tokenReduction });
  });

  it('accepts user-facing aliases and defaults configured policies to shadow', () => {
    expect(resolveOptimizationPolicy({
      env: { TESTRONAUT_OPTIMIZE: 'both' }, config: {},
    })).toMatchObject({ objective: 'balanced', mode: 'shadow' });
  });

  it('gives environment values precedence over config', () => {
    expect(resolveOptimizationPolicy({
      env: { TESTRONAUT_OPTIMIZE: 'cost', TESTRONAUT_OPTIMIZATION_MODE: 'live' },
      config: { optimization: { objective: 'tokens', mode: 'shadow' } },
    })).toMatchObject({ objective: 'cost', mode: 'live', routing: true });
  });

  it('translates policy to legacy Jev controls without replacing explicit overrides', () => {
    const env = { TESTRONAUT_JEV_GATE: '0' };
    applyOptimizationPolicy(resolveOptimizationPolicy({
      env: {}, config: { optimization: { objective: 'balanced', mode: 'live' } },
    }), env);
    expect(env).toMatchObject({
      TESTRONAUT_JEV_ROUTING: 'live',
      TESTRONAUT_JEV_GATE: '0',
      TESTRONAUT_JEV_STRATEGIES: '1',
      TESTRONAUT_JEV_SHADOW: '1',
      TESTRONAUT_JEV_ROUTING_THRESHOLD: '0.4',
    });
  });

  it('allows explicit CLI policy to replace lower-level overrides', () => {
    const env = { TESTRONAUT_JEV_GATE: '1', TESTRONAUT_JEV_ROUTING: 'live' };
    applyOptimizationPolicy(resolveOptimizationPolicy({
      env: { TESTRONAUT_OPTIMIZE: 'off' }, config: {},
    }), env, { force: true });
    expect(env).toMatchObject({ TESTRONAUT_JEV_GATE: '0', TESTRONAUT_JEV_ROUTING: 'off' });
  });
});
