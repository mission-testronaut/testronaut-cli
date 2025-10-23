import { describe, it, expect } from 'vitest';
import { makeEnvTemplate } from '../../bin/initHelpers';

describe('makeEnvTemplate', () => {
  it('returns OpenAI template', () => {
    const s = makeEnvTemplate('openai');
    expect(s).toMatch(/OPENAI_API_KEY=sk-\.\.\./);
  });

  it('returns Gemini template', () => {
    const s = makeEnvTemplate('gemini');
    expect(s).toMatch(/GEMINI_API_KEY=AIza\.\.\./);
  });
});
