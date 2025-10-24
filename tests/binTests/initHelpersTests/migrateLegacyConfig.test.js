import { describe, it, expect } from 'vitest';
import { migrateLegacyConfig } from '../../../bin/initHelpers';

describe('migrateLegacyConfig', () => {
  it('sets provider=openai when model=openai and provider is missing', () => {
    const out = migrateLegacyConfig({ model: 'openai' });
    expect(out.provider).toBe('openai');
  });

  it('does not override existing provider', () => {
    const out = migrateLegacyConfig({ model: 'openai', provider: 'gemini' });
    expect(out.provider).toBe('gemini');
  });

  it('keeps unrelated configs intact', () => {
    const out = migrateLegacyConfig({ foo: 1, bar: 'x' });
    expect(out).toEqual({ foo: 1, bar: 'x' });
  });
});
