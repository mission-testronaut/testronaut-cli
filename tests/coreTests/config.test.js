import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import {
  loadConfig,
  getMaxTurns,
  getRetryLimit,
  resolveTurnLimits,
  enforceTurnBudget,
  getDomListLimit,
  getResourceGuardConfig,
} from '../../core/config.js';

describe('core/config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.STRICT_LIMITS;
  });

  describe('loadConfig', () => {
    it('parses JSON when present', async () => {
      readFile.mockResolvedValueOnce(JSON.stringify({ maxTurns: 33 }));
      const cfg = await loadConfig('/any');
      expect(cfg).toEqual({ maxTurns: 33 });
    });

    it('returns {} on ENOENT', async () => {
      readFile.mockRejectedValueOnce(new Error('ENOENT'));
      const cfg = await loadConfig('/missing');
      expect(cfg).toEqual({});
    });

    it('returns {} on invalid JSON', async () => {
      readFile.mockResolvedValueOnce('{ nope ');
      const cfg = await loadConfig('/bad');
      expect(cfg).toEqual({});
    });
  });

  describe('getMaxTurns', () => {
    it('uses fallback when invalid or missing', () => {
      expect(getMaxTurns({}, 20)).toBe(20);
      expect(getMaxTurns({ maxTurns: 'x' }, 20)).toBe(20);
      expect(getMaxTurns({ maxTurns: 0 }, 20)).toBe(20);
      expect(getMaxTurns({ maxTurns: -5 }, 20)).toBe(20);
    });

    it('returns numeric when valid', () => {
      expect(getMaxTurns({ maxTurns: 7 }, 20)).toBe(7);
      expect(getMaxTurns({ maxTurns: '15' }, 20)).toBe(15);
    });
  });

  describe('resolveTurnLimits', () => {
    it('returns expected defaults', () => {
      const l = resolveTurnLimits();
      expect(l.softMaxTurns).toBe(50);
      expect(l.hardMaxTurns).toBe(200);
      expect(l.hardMinTurns).toBe(5);
      expect(l.maxIdleTurns).toBe(6);
      expect(l.maxErrors).toBe(5);
      expect(l.maxSeconds).toBe(600);
    });
  });

  describe('getRetryLimit', () => {
    const OLD_ENV = { ...process.env };
    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env.TESTRONAUT_RETRY_LIMIT;
    });
    afterEach(() => {
      process.env = { ...OLD_ENV };
    });

    it('returns default when missing', () => {
      const res = getRetryLimit({});
      expect(res.value).toBe(2);
      expect(res.source).toBe('default');
      expect(res.clamped).toBe(false);
    });

    it('uses config value and clamps to range', () => {
      expect(getRetryLimit({ retryLimit: 5 }).value).toBe(5);
      const high = getRetryLimit({ retryLimit: 99 });
      expect(high.value).toBe(10);
      expect(high.clamped).toBe(true);
      const low = getRetryLimit({ retryLimit: 0 });
      expect(low.value).toBe(1);
      expect(low.clamped).toBe(true);
    });

    it('prefers env over config and clamps', () => {
      process.env.TESTRONAUT_RETRY_LIMIT = '8';
      const res = getRetryLimit({ retryLimit: 3 });
      expect(res.value).toBe(8);
      expect(res.source).toBe('env');

      process.env.TESTRONAUT_RETRY_LIMIT = '0';
      const clampedLow = getRetryLimit({ retryLimit: 3 });
      expect(clampedLow.value).toBe(1);
      expect(clampedLow.clamped).toBe(true);
    });
  });

  describe('getDomListLimit', () => {
    const OLD_ENV = { ...process.env };
    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env.TESTRONAUT_DOM_LIST_LIMIT;
    });
    afterEach(() => {
      process.env = { ...OLD_ENV };
    });

    it('returns default when missing', () => {
      const res = getDomListLimit({});
      expect(res.value).toBe(3);
      expect(res.mode).toBe('number');
      expect(res.source).toBe('default');
      expect(res.clamped).toBe(false);
    });

    it('uses config value (nested) and clamps to range', () => {
      const res = getDomListLimit({ dom: { listItemLimit: 250 } });
      expect(res.value).toBe(100);
      expect(res.mode).toBe('number');
      expect(res.source).toBe('config');
      expect(res.clamped).toBe(true);

      const nestedAlt = getDomListLimit({ dom: { listLimit: '9' } });
      expect(nestedAlt.value).toBe(9);
      expect(nestedAlt.source).toBe('config');
    });

    it('prefers env override and accepts keywords', () => {
      process.env.TESTRONAUT_DOM_LIST_LIMIT = 'all';
      const allRes = getDomListLimit({ domListLimit: 2 });
      expect(allRes.value).toBe(Infinity);
      expect(allRes.mode).toBe('all');
      expect(allRes.source).toBe('env');

      process.env.TESTRONAUT_DOM_LIST_LIMIT = 'none';
      const noneRes = getDomListLimit({ domListLimit: 5 });
      expect(noneRes.value).toBe(0);
      expect(noneRes.mode).toBe('none');
      expect(noneRes.source).toBe('env');
    });

    it('accepts numeric strings', () => {
      const res = getDomListLimit({ domListLimit: '7' });
      expect(res.value).toBe(7);
      expect(res.mode).toBe('number');
    });
  });

  describe('getResourceGuardConfig', () => {
    const OLD_ENV = { ...process.env };
    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env.TESTRONAUT_RESOURCE_GUARD;
      delete process.env.TESTRONAUT_RESOURCE_HREF_PATTERNS;
      delete process.env.TESTRONAUT_RESOURCE_DATA_TYPES;
    });
    afterEach(() => {
      process.env = { ...OLD_ENV };
    });

    it('returns defaults when nothing is set', () => {
      const res = getResourceGuardConfig({});
      expect(res.enabled).toBe(true);
      expect(res.hrefIncludes.length).toBeGreaterThan(0);
      expect(res.dataTypes).toContain('document');
    });

    it('respects env toggles and lists', () => {
      process.env.TESTRONAUT_RESOURCE_GUARD = 'false';
      process.env.TESTRONAUT_RESOURCE_HREF_PATTERNS = '/a,/b';
      process.env.TESTRONAUT_RESOURCE_DATA_TYPES = 'doc,file';
      const res = getResourceGuardConfig({ resourceGuard: { enabled: true } });
      expect(res.enabled).toBe(false);
      expect(res.hrefIncludes).toEqual(['/a', '/b']);
      expect(res.dataTypes).toEqual(['doc', 'file']);
    });

    it('falls back to config arrays when env missing', () => {
      const res = getResourceGuardConfig({
        resourceGuard: {
          enabled: 'yes',
          hrefIncludes: ['/x', '/y'],
          dataTypes: ['row'],
        },
      });
      expect(res.enabled).toBe(true);
      expect(res.hrefIncludes).toEqual(['/x', '/y']);
      expect(res.dataTypes).toEqual(['row']);
    });
  });

  describe('enforceTurnBudget (lenient)', () => {
    it('clamps > hardMaxTurns', () => {
      const cfg = { maxTurns: 1000 };
      const { effectiveMax, limits, notes, strict } = enforceTurnBudget(cfg);
      expect(strict).toBe(false);
      expect(effectiveMax).toBe(limits.hardMaxTurns);
      expect(notes.join('\n')).toMatch(/Clamping to/i);
    });

    it('warns when > softMaxTurns but <= hardMaxTurns', () => {
      const cfg = { maxTurns: 120 };
      const { effectiveMax, limits, notes } = enforceTurnBudget(cfg);
      expect(effectiveMax).toBe(120);
      expect(notes.join('\n')).toMatch(/exceeds softMaxTurns/i);
      expect(effectiveMax).toBeLessThanOrEqual(limits.hardMaxTurns);
    });

    it('raises to hardMinTurns when below minimum', () => {
      const cfg = { maxTurns: 1 };
      const { effectiveMax, limits, notes } = enforceTurnBudget(cfg);
      expect(effectiveMax).toBe(limits.hardMinTurns);
      expect(notes.join('\n')).toMatch(/Raising to/i);
    });

    it('normalizes soft>hard ordering with a note', () => {
      const weird = {
        softMaxTurns: 300,
        hardMaxTurns: 200,
        hardMinTurns: 5,
        maxIdleTurns: 6,
        maxErrors: 5,
        maxSeconds: 600,
      };
      const { limits, notes } = enforceTurnBudget({ maxTurns: 20 }, weird);
      expect(limits.softMaxTurns).toBe(limits.hardMaxTurns);
      expect(notes.join('\n')).toMatch(/Adjusted softMaxTurns down to hardMaxTurns/);
    });
  });

  describe('enforceTurnBudget (strict)', () => {
    it('throws when > hardMaxTurns', () => {
      const cfg = { maxTurns: 999, strictLimits: true };
      expect(() => enforceTurnBudget(cfg)).toThrow(/exceeds hardMaxTurns/i);
    });

    it('throws when below hardMinTurns', () => {
      process.env.STRICT_LIMITS = '1';
      const cfg = { maxTurns: 2 };
      expect(() => enforceTurnBudget(cfg)).toThrow(/below hardMinTurns/i);
    });

    it('throws when softMaxTurns > hardMaxTurns', () => {
      const bad = {
        softMaxTurns: 300,
        hardMaxTurns: 200,
        hardMinTurns: 5,
        maxIdleTurns: 6,
        maxErrors: 5,
        maxSeconds: 600,
      };
      expect(() => enforceTurnBudget({ strictLimits: true, maxTurns: 20 }, bad))
        .toThrow(/softMaxTurns .* > hardMaxTurns/);
    });
  });


    describe('enforceTurnBudget env override', () => {
    const old = process.env.TESTRONAUT_TURNS;

    beforeEach(() => { delete process.env.TESTRONAUT_TURNS; });
    afterEach(() => { if (old === undefined) delete process.env.TESTRONAUT_TURNS; else process.env.TESTRONAUT_TURNS = old; });

    it('uses TESTRONAUT_TURNS over cfg.maxTurns', () => {
        process.env.TESTRONAUT_TURNS = '30';
        const { effectiveMax, notes } = enforceTurnBudget({ maxTurns: 5 });
        expect(effectiveMax).toBe(30);
        expect(notes.join('\n')).toMatch(/CLI turn override/i);
    });
    });
});
