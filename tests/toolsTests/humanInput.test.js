import { describe, it, expect } from 'vitest';
import {
  sanitizeHumanCodeInput,
  normalizeHumanInputOptions,
} from '../../tools/humanInput.js';

describe('tools/humanInput', () => {
  it('accepts short verification codes and removes whitespace', () => {
    expect(sanitizeHumanCodeInput(' 123 456 ').value).toBe('123456');
    expect(sanitizeHumanCodeInput('AB-12_cd').ok).toBe(true);
  });

  it('rejects empty, long, and unsafe input', () => {
    expect(sanitizeHumanCodeInput('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(sanitizeHumanCodeInput('a'.repeat(65))).toMatchObject({ ok: false, reason: 'too_long' });
    expect(sanitizeHumanCodeInput('abc@example.com')).toMatchObject({ ok: false, reason: 'invalid_characters' });
  });

  it('normalizes timeout and length limits', () => {
    const low = normalizeHumanInputOptions({ timeoutSeconds: 1, maxLength: 1000 });
    expect(low.timeoutSeconds).toBe(5);
    expect(low.maxLength).toBe(64);
    expect(low.timeoutClamped).toBe(true);
    expect(low.maxLengthClamped).toBe(true);
  });
});
