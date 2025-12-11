import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks
vi.mock('../../core/agent.js', () => ({ runAgent: vi.fn() }));
vi.mock('../../core/redaction.js', () => ({
  // simple deterministic redaction stub
  redactPasswordInText: (s) => String(s).replace(/password:\s*\S+/gi, 'password: ********'),
}));
vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(),
  enforceTurnBudget: vi.fn(),
  getRetryLimit: vi.fn(),
  getDomListLimit: vi.fn(),
  getResourceGuardConfig: vi.fn(),
}));

import { runAgent } from '../../core/agent.js';
import { loadConfig, enforceTurnBudget, getRetryLimit, getDomListLimit, getResourceGuardConfig } from '../../core/config.js';

// Adjust the import path if your file lives elsewhere
import { runMissions, __test__ as testronautInternals } from '../../runner/testronaut.js';

describe('cli/testronaut.runMissions (with enforceTurnBudget)', () => {
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    vi.clearAllMocks();
    // Default retry limit unless overridden in a test
    getRetryLimit.mockReturnValue({ value: 2, source: 'default', clamped: false });
    getDomListLimit.mockReturnValue({ value: 3, mode: 'number', source: 'default', clamped: false });
    getResourceGuardConfig.mockReturnValue({ enabled: true, hrefIncludes: ['/document/'], dataTypes: ['document'] });
  });

  it('passes effectiveMax to runAgent and logs any notes', async () => {
    loadConfig.mockResolvedValue({ maxTurns: 999 });
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 200,
      limits: { softMaxTurns: 50, hardMaxTurns: 200, hardMinTurns: 5 },
      notes: ['⚠️ maxTurns (999) exceeds hardMaxTurns (200). Clamping to 200.'],
      strict: false,
    });
    getRetryLimit.mockReturnValue({ value: 2, source: 'default', clamped: false });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    runAgent.mockResolvedValue([
      { steps: [{ result: 'SUCCESS: done' }], status: 'passed' },
    ]);

    await runMissions({ mission: 'Do xyz' }, 'Budgeted Run');

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(enforceTurnBudget).toHaveBeenCalledWith({ maxTurns: 999 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Clamping to 200')
    );
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(Array), 'Budgeted Run', 200, 2, { domListLimit: 3, debug: false, resourceGuard: { enabled: true, hrefIncludes: ['/document/'], dataTypes: ['document'] } }
    );

    warn.mockRestore();
    log.mockRestore();
  });

  it('does not warn when no notes are returned', async () => {
    loadConfig.mockResolvedValue({ maxTurns: 20 });
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 20,
      limits: { softMaxTurns: 50, hardMaxTurns: 200, hardMinTurns: 5 },
      notes: [],
      strict: false,
    });
    getRetryLimit.mockReturnValue({ value: 3, source: 'default', clamped: false });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    runAgent.mockResolvedValue([
      { steps: [{ result: 'SUCCESS: ok' }], status: 'passed' },
    ]);

    await runMissions({ mission: 'No warnings' }, 'Clean');

    expect(warn).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(expect.any(Array), 'Clean', 20, 3, { domListLimit: 3, debug: false, resourceGuard: { enabled: true, hrefIncludes: ['/document/'], dataTypes: ['document'] } });

    warn.mockRestore();
    log.mockRestore();
  });

  it('warns when the DOM list limit is clamped', async () => {
    loadConfig.mockResolvedValue({});
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 20,
      limits: {},
      notes: [],
      strict: false,
    });
    getDomListLimit.mockReturnValue({ value: 100, mode: 'number', source: 'config', clamped: true });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runAgent.mockResolvedValue([
      { steps: [{ result: 'SUCCESS: ok' }], status: 'passed' },
    ]);

    await runMissions({ mission: 'Clamp lists' }, 'Clamp Mission');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('DOM list limit clamped to 100')
    );

    warn.mockRestore();
    log.mockRestore();
  });

  it('marks first mission failed when last step result includes "failure"', async () => {
    loadConfig.mockResolvedValue({});
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 20,
      limits: {},
      notes: [],
      strict: false,
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runAgent.mockResolvedValue([
      { steps: [{ result: 'FAILURE: could not do it' }], status: 'passed' },
    ]);

    const res = await runMissions({ mission: 'Will fail' }, 'Status');
    expect(res[0].status).toBe('failed');

    log.mockRestore();
  });

  it('normalizes single strings and functions into arrays and names missions', async () => {
    loadConfig.mockResolvedValue({});
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 15,
      limits: {},
      notes: [],
      strict: false,
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runAgent.mockResolvedValue([
      { steps: [{ result: 'SUCCESS: done' }], status: 'passed' },
    ]);

    function preTask() {}
    function postTask() {}

    await runMissions(
      {
        preMission: preTask,
        mission: 'Main mission text\nwith details',
        postMission: postTask,
      },
      'My Mission'
    );

    // Check that runAgent got 3 goals (pre/main/post)
    const call = (runAgent.mock.calls[0] || []);
    const goals = call[0];
    expect(Array.isArray(goals)).toBe(true);
    expect(goals).toHaveLength(3);

    // Submission types and names are set
    expect(goals[0].submissionType).toBe('premission');
    expect(goals[1].submissionType).toBe('mission');
    expect(goals[2].submissionType).toBe('postmission');

    // Mission name is the passed-in missionName for main
    expect(goals[1].submissionName).toMatch(/^My Mission/);

    // Effective max turns and retry limit passed through
    expect(runAgent).toHaveBeenCalledWith(expect.any(Array), 'My Mission', 15, 2, { domListLimit: 3, debug: false, resourceGuard: { enabled: true, hrefIncludes: ['/document/'], dataTypes: ['document'] } });

    log.mockRestore();
  });

  it('aborts early when runAgent returns falsy (defensive)', async () => {
    loadConfig.mockResolvedValue({});
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 10,
      limits: {},
      notes: [],
      strict: false,
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runAgent.mockResolvedValue(null); // simulate unexpected falsy

    const res = await runMissions({ mission: 'Edge case' }, 'Abort');
    expect(res).toBeUndefined();

    log.mockRestore();
  });

  it('passes debug flag through when TESTRONAUT_DEBUG is set', async () => {
    process.env.TESTRONAUT_DEBUG = 'true';
    loadConfig.mockResolvedValue({});
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 20,
      limits: {},
      notes: [],
      strict: false,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runAgent.mockResolvedValue([
      { steps: [{ result: 'SUCCESS: ok' }], status: 'passed' },
    ]);

    await runMissions({ mission: 'Debug' }, 'Debug Mission');

    expect(runAgent).toHaveBeenCalledWith(expect.any(Array), 'Debug Mission', 20, 2, { domListLimit: 3, debug: true, resourceGuard: { enabled: true, hrefIncludes: ['/document/'], dataTypes: ['document'] } });

    log.mockRestore();
  });

  describe('__test__ helpers', () => {
    it('formats list limits and reads debug env', () => {
      const { isDebugEnabled, formatListLimit } = testronautInternals;
      process.env.TESTRONAUT_DEBUG = 'on';
      expect(isDebugEnabled()).toBe(true);
      process.env.TESTRONAUT_DEBUG = '0';
      expect(isDebugEnabled()).toBe(false);
      expect(formatListLimit(Infinity)).toBe('all');
      expect(formatListLimit(5)).toBe(5);
    });
  });
});
