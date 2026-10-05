import { describe, expect, it } from 'vitest';
import { createTerminalUi, shouldUseColor } from '../../bin/terminalUi.js';

function capture() {
  let output = '';
  return {
    stream: { isTTY: false, write(value) { output += value; } },
    read: () => output,
  };
}

describe('terminal UI', () => {
  it('renders a readable color-free mission lifecycle', () => {
    const target = capture();
    const ui = createTerminalUi({ stream: target.stream, color: false });

    ui.banner({ version: '1.2.3', provider: 'openai', model: 'gpt-test', session: 'isolated' });
    ui.phase('launch', 'login.mission.js');
    ui.mission(true, 'login.mission.js', ['smoke']);
    ui.summary({ totalMissions: 1, passed: 1, failed: 0, reportPath: 'reports/run.html' });

    expect(target.read()).toContain('🧑‍🚀 TESTRONAUT  /  MISSION RUNNER');
    expect(target.read()).toContain('LAUNCH    login.mission.js');
    expect(target.read()).toContain('#smoke');
    expect(target.read()).toContain('MISSION COMPLETE');
    expect(target.read()).not.toContain('\u001b[');
  });

  it('honors terminal capability and NO_COLOR', () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '' })).toBe(false);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
  });
});
