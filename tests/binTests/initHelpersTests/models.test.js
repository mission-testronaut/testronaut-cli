import { describe, it, expect } from 'vitest';
import { openAIModels, geminiModels, isKnownModel, pickInitialIndex } from '../../../bin/initHelpers';

describe('model helpers', () => {
  it('lists known models', () => {
    expect(openAIModels()).toContain('gpt-4o');
    expect(openAIModels()).toEqual(expect.arrayContaining([
      'gpt-5.2',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.5',
      'gpt-5.6',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]));
    expect(openAIModels()).not.toContain('gpt-5.3');
    expect(geminiModels()).toContain('gemini-2.5-flash');
  });

  it('recognizes known models by provider', () => {
    expect(isKnownModel('openai', 'gpt-4.1-mini')).toBe(true);
    expect(isKnownModel('gemini', 'gpt-4.1-mini')).toBe(false);
  });

  it('picks initial index from list or fallback', () => {
    const list = ['a','b','c'];
    expect(pickInitialIndex(list, 'b', 'c')).toBe(1);
    expect(pickInitialIndex(list, 'z', 'c')).toBe(2);
    expect(pickInitialIndex(list, 'z', 'y')).toBe(0);
  });
});
