import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../../bin/initHelpers';

describe('defaultConfig', () => {
  it('creates sane defaults', () => {
    const cfg = defaultConfig('my-app');
    expect(cfg.initialized).toBe(true);
    expect(cfg.outputDir).toBe('missions/mission_reports');
    expect(cfg.projectName).toBe('my-app');
    expect(cfg.maxTurns).toBe(20);
    expect(cfg.dom?.listItemLimit).toBe(3);
    expect(cfg.resourceGuard?.enabled).toBe(true);
    expect(cfg.resourceGuard?.hrefIncludes).toContain('/document/');
  });
});
