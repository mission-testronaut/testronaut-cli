import { describe, expect, it } from 'vitest';
import { CROSS_PROVIDER_CONDITIONS, buildCrossProviderSchedule, commandForCrossProviderRun, interpretSelection } from '../../experiments/crossProviderBenchmark.js';

describe('cross-provider benchmark', () => {
  it('builds 120 deterministic isolated mission executions', () => {
    const first = buildCrossProviderSchedule();
    const repeat = buildCrossProviderSchedule();
    expect(first).toHaveLength(120);
    expect(first.map(run => run.key)).toEqual(repeat.map(run => run.key));
    for (let block = 1; block <= 5; block += 1) {
      expect(first.filter(run => run.block === block)).toHaveLength(24);
    }
  });

  it('limits portfolios to two models and crosses providers', () => {
    for (const condition of CROSS_PROVIDER_CONDITIONS) expect(condition.candidates.length).toBeLessThanOrEqual(2);
    for (const condition of CROSS_PROVIDER_CONDITIONS.filter(item => item.id.startsWith('x'))) {
      expect(new Set(condition.candidates.map(item => item.provider)).size).toBe(2);
    }
  });

  it('uses a sufficiently confident Jev selection and otherwise falls back', () => {
    const candidates = CROSS_PROVIDER_CONDITIONS.find(item => item.id.startsWith('x')).candidates;
    const chosen = interpretSelection({ status: 'ok', answers: { executionModel: { choice: 'model_2', probabilities: { model_2: 0.8 } } } }, candidates);
    expect(chosen).toMatchObject({ selected: candidates[1], selectedBy: 'jev', score: 0.8 });
    const fallback = interpretSelection({ status: 'ok', answers: { executionModel: { choice: 'model_2', probabilities: { model_2: 0.4 } } } }, candidates);
    expect(fallback).toMatchObject({ selected: candidates[0], selectedBy: 'fallback' });
  });

  it('runs one mission with guardrails and no intra-mission fast model', () => {
    const run = buildCrossProviderSchedule({ repetitions: 1 })[0];
    const selection = { selected: run.candidates[0] };
    const invocation = commandForCrossProviderRun(run, selection, '/cli.js');
    expect(invocation.args).toEqual(['/cli.js', `--provider=${selection.selected.provider}`, `--model=${selection.selected.model}`, '--optimize=tokens', '--optimization-mode=live', run.mission]);
    expect(invocation.args.filter(arg => arg.endsWith('.mission.js'))).toHaveLength(1);
  });
});
