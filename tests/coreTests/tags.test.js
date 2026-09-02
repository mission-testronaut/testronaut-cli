import { describe, expect, it } from 'vitest';
import { matchesTagFilter, normalizeTagMatch, normalizeTags } from '../../core/tags.js';

describe('tag helpers', () => {
  it('normalizes case, order, and duplicates', () => {
    expect(normalizeTags(['Smoke', 'authentication', 'smoke'])).toEqual(['authentication', 'smoke']);
  });

  it('treats omitted and blank optional tag sources as no tags', () => {
    expect(normalizeTags()).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags('')).toEqual([]);
    expect(normalizeTags('   ')).toEqual([]);
  });

  it('rejects spaces and the reserved untagged value', () => {
    expect(() => normalizeTags(['human in loop'])).toThrow(/Invalid tag/);
    expect(() => normalizeTags(['untagged'])).toThrow(/reserved/);
  });

  it('supports any, all, and untagged matching', () => {
    expect(matchesTagFilter(['smoke'], ['smoke', 'checkout'], 'any')).toBe(true);
    expect(matchesTagFilter(['smoke'], ['smoke', 'checkout'], 'all')).toBe(false);
    expect(matchesTagFilter([], ['untagged'], 'any')).toBe(true);
  });

  it('defaults tag matching to any', () => {
    expect(normalizeTagMatch()).toBe('any');
    expect(() => normalizeTagMatch('some')).toThrow(/any.*all/);
  });
});
