// tests/coreTests/agent.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1) Provide a constructable mock without using `vi` inside the factory.
vi.mock('../../tools/chromeBrowser.js', () => {
  function ChromeBrowser() {}
  ChromeBrowser.prototype.start = async function () {};
  ChromeBrowser.prototype.close = async function () {};
  return { ChromeBrowser };
});

// Keep turnLoop simple; using vi is fine here (no factory-hoist issue)
vi.mock('../../core/turnLoop.js', () => ({
  turnLoop: vi.fn(),
}));

import { ChromeBrowser } from '../../tools/chromeBrowser.js';
import { turnLoop } from '../../core/turnLoop.js';
import { runAgent } from '../../core/agent.js';

let startSpy, closeSpy;

describe('core/agent.runAgent', () => {
  beforeEach(() => {
    // 2) Spy on prototype methods AFTER import time
    startSpy = vi.spyOn(ChromeBrowser.prototype, 'start').mockResolvedValue();
    closeSpy = vi.spyOn(ChromeBrowser.prototype, 'close').mockResolvedValue();
    vi.clearAllMocks();
  });

  afterEach(() => {
    startSpy.mockRestore();
    closeSpy.mockRestore();
  });

  it('runs all goals and returns missionResults (all passed)', async () => {
    turnLoop
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });

    const goals = [
      { goal: 'Do A', submissionType: 'mission', submissionName: 'A' },
      { goal: 'Do B', submissionType: 'mission', submissionName: 'B' },
    ];

    const res = await runAgent(goals, 'My Mission', 10);

    // Browser lifecycle
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // turnLoop called once per goal and receives maxTurns
    expect(turnLoop).toHaveBeenCalledTimes(2);
    expect(turnLoop.mock.calls[0][2]).toBe(10);
    expect(turnLoop.mock.calls[1][2]).toBe(10);

    expect(res).toHaveLength(2);
    expect(res[0].status).toBe('passed');
    expect(res[1].status).toBe('passed');
  });

  it('stops early on first failure and returns partial results', async () => {
    turnLoop.mockResolvedValueOnce({ success: false });

    const res = await runAgent(
      [
        { goal: 'A', submissionType: 'mission', submissionName: 'A' },
        { goal: 'B', submissionType: 'mission', submissionName: 'B' },
      ],
      'Fail Mission',
      7
    );

    expect(turnLoop).toHaveBeenCalledTimes(1);
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe('failed');
  });

  it('coerces non-string goal to string for the user message', async () => {
    turnLoop.mockResolvedValueOnce({ success: true });

    await runAgent([{ goal: { toString: () => 'coerced text' } }], 'Coerce', 5);

    const messages = turnLoop.mock.calls[0][1];
    expect(messages[1]).toEqual({ role: 'user', content: 'coerced text' });
  });

  it('deep-clones steps so external mutations do not leak', async () => {
    turnLoop.mockImplementationOnce(async (browser, messages, maxTurns, ct, rc, cs, ctx) => {
      ctx.steps.push({ result: 'SUCCESS: step1' });
      return { success: true };
    });

    const res1 = await runAgent([{ goal: 'Check clone' }], 'Clone Test', 3);
    res1[0].steps[0].result = 'TAMPERED';

    turnLoop.mockImplementationOnce(async (browser, messages, maxTurns, ct, rc, cs, ctx) => {
      ctx.steps.push({ result: 'SUCCESS: step2' });
      return { success: true };
    });

    const res2 = await runAgent([{ goal: 'Check clone' }], 'Clone Test 2', 3);
    expect(res1[0].steps[0].result).toBe('TAMPERED');
    expect(res2[0].steps[0].result).toBe('SUCCESS: step2');
  });

  it('includes missionName and submission metadata in results', async () => {
    turnLoop.mockResolvedValueOnce({ success: true });

    const res = await runAgent(
      [
        {
          goal: 'Meta',
          submissionType: 'mission',
          submissionName: 'MetaName',
          label: 'legacy-label',
        },
      ],
      'MetaMission',
      4
    );

    expect(res[0].missionName).toBe('MetaMission');
    expect(res[0].submissionType).toBe('mission');
    expect(res[0].submissionName).toBe('MetaName');
  });
});
