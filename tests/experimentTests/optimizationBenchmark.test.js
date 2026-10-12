import { describe, expect, it } from 'vitest';
import { BENCHMARK_TARGETS, buildBenchmarkSchedule, commandForRun } from '../../experiments/optimizationBenchmark.js';

describe('optimization benchmark matrix', () => {
  it('builds seven conditions and five blocked repetitions per repository', () => {
    const schedule = buildBenchmarkSchedule();
    expect(schedule).toHaveLength(70);
    expect(schedule.filter(run => run.target === 'openai')).toHaveLength(35);
    expect(schedule.filter(run => run.target === 'gemini')).toHaveLength(35);
    for (const target of ['openai', 'gemini']) {
      for (let block = 1; block <= 5; block += 1) {
        const runs = schedule.filter(run => run.target === target && run.block === block);
        expect(runs).toHaveLength(7);
        expect(new Set(runs.map(run => run.id)).size).toBe(7);
      }
    }
  });

  it('is deterministically randomized by seed', () => {
    const first = buildBenchmarkSchedule({ repetitions: 2, seed: 'one' }).map(run => run.key);
    const repeat = buildBenchmarkSchedule({ repetitions: 2, seed: 'one' }).map(run => run.key);
    const other = buildBenchmarkSchedule({ repetitions: 2, seed: 'two' }).map(run => run.key);
    expect(first).toEqual(repeat);
    expect(first).not.toEqual(other);
  });

  it('keeps routed conditions to exactly two execution models', () => {
    for (const target of Object.values(BENCHMARK_TARGETS)) {
      for (const condition of target.conditions) {
        expect([condition.primary, condition.secondary].filter(Boolean).length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('constructs explicit, reproducible CLI arguments', () => {
    const run = buildBenchmarkSchedule({ repetitions: 1, targets: ['openai'] })
      .find(item => item.id === 'l4_terra_gpt55');
    const invocation = commandForRun(run, '/cli/bin.js');
    expect(invocation.args).toEqual(expect.arrayContaining([
      '/cli/bin.js', '--provider=openai', '--model=gpt-5.6-terra',
      '--optimize=cost', '--optimization-mode=live', 'missions/login.mission.js',
    ]));
    expect(invocation.env).toMatchObject({
      TESTRONAUT_JEV_FAST_MODEL: 'gpt-5.5',
      TESTRONAUT_JEV_ROUTING_THRESHOLD: '0.4',
      TESTRONAUT_BETA_MODEL_ROUTING: '1',
    });
  });
});
