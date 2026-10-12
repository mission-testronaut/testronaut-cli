import { describe, expect, it } from 'vitest';
import { buildJevSuiteSelectionRequest, interpretJevSuiteSelection } from '../../core/jevSuiteSelection.js';

describe('Jev suite selection', () => {
  it('creates one bounded decision per mission and applies a threshold', () => {
    const request = buildJevSuiteSelectionRequest({
      changedFiles: ['src/auth/login.js'],
      missions: [
        { file: 'login.mission.js', tags: ['auth'] },
        { file: 'billing.mission.js', tags: ['billing'] },
      ],
    });
    expect(Object.keys(request.questions)).toEqual(['select_mission_1', 'select_mission_2']);
    expect(request.state.changedFiles).toEqual(['src/auth/login.js']);

    expect(interpretJevSuiteSelection({
      select_mission_1: { noul: 0.95 },
      select_mission_2: { noul: 0.2 },
    }, request.catalog, 0.7)).toEqual([
      { file: 'login.mission.js', tags: ['auth'], probability: 0.95, selected: true },
      { file: 'billing.mission.js', tags: ['billing'], probability: 0.2, selected: false },
    ]);
  });
});
