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
}));

import { runAgent } from '../../core/agent.js';
import { loadConfig, enforceTurnBudget } from '../../core/config.js';

// Adjust the import path if your file lives elsewhere
import { runMissions } from '../../runner/testronaut.js';

describe('cli/testronaut.runMissions (with enforceTurnBudget)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes effectiveMax to runAgent and logs any notes', async () => {
    loadConfig.mockResolvedValue({ maxTurns: 999 });
    enforceTurnBudget.mockReturnValue({
      effectiveMax: 200,
      limits: { softMaxTurns: 50, hardMaxTurns: 200, hardMinTurns: 5 },
      notes: ['⚠️ maxTurns (999) exceeds hardMaxTurns (200). Clamping to 200.'],
      strict: false,
    });

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
      expect.any(Array), 'Budgeted Run', 200
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

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    runAgent.mockResolvedValue([
      { steps: [{ result: 'SUCCESS: ok' }], status: 'passed' },
    ]);

    await runMissions({ mission: 'No warnings' }, 'Clean');

    expect(warn).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(expect.any(Array), 'Clean', 20);

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

    // Effective max turns passed through
    expect(runAgent).toHaveBeenCalledWith(expect.any(Array), 'My Mission', 15);

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
});
