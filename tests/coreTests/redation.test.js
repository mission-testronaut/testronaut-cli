/**
 * redaction.test.js
 * -----------------
 * Purpose:
 *   Vitest unit tests for redaction utilities:
 *   - Centralized keyword usage
 *   - Tool arg masking (selector & key-name based)
 *   - Free-text masking for plans/instructions
 *
 * Test runner:
 *   Vitest (https://vitest.dev/)
 *
 * Location:
 *   tests/core/redaction.test.js
 */

import { describe, it, expect } from 'vitest';
import {
  SENSITIVE_KEYWORDS,
  maskPreview,
  redactArgs,
  redactPasswordInText,
} from '../../core/redaction.js';

describe('redaction utilities', () => {
  describe('SENSITIVE_KEYWORDS (centralized list)', () => {
    it('contains expected baseline keywords', () => {
      const expected = ['password', 'token', 'access', 'api-key', 'auth'];
      for (const k of expected) {
        expect(SENSITIVE_KEYWORDS).toContain(k);
      }
    });
  });

  describe('maskPreview', () => {
    it('masks and includes length by default', () => {
      expect(maskPreview('hunter2')).toBe('•••••• (7)');
    });

    it('masks empty-ish values without length', () => {
      expect(maskPreview('')).toBe('••••••');
      expect(maskPreview(null)).toBe('••••••');
      expect(maskPreview(undefined)).toBe('••••••');
    });

    it('respects showLength=false', () => {
      expect(maskPreview('abcdef', false)).toBe('••••••');
    });
  });

  describe('redactArgs', () => {
    it('masks when selector contains #access', () => {
      const args = { selector: '#access', text: 'Imp0st3r123!' };
      const redacted = redactArgs('fill', args);
      expect(redacted.text).toMatch(/^•••••• \(\d+\)$/);
      expect(redacted.selector).toBe('#access'); // selector remains visible
    });

    it('masks when inputType is password', () => {
      const args = { selector: '#login', inputType: 'password', value: 'superSecret' };
      const redacted = redactArgs('type', args);
      expect(redacted.value).toBe('•••••• (11)');
    });

    it('masks values by sensitive arg key names (e.g., apiKey, token)', () => {
      const args = { apiKey: 'sk-live-abc', token: 'abcd1234', other: 'notSecret' };
      const redacted = redactArgs('noop', args); // fnName not type/fill still masks by key name
      expect(redacted.apiKey).toBe('•••••• (11)');
      expect(redacted.token).toBe('•••••• (8)');
      expect(redacted.other).toBe('notSecret');
    });

    it('does not mask non-sensitive calls', () => {
      const args = { selector: '#search', text: 'hello world' };
      const redacted = redactArgs('fill', args);
      expect(redacted.text).toBe('hello world');
    });
  });

  describe('redactPasswordInText', () => {
    it('Case 1: keyword ... "VALUE"', () => {
      const input = `My password is "hunter2".`;
      const out = redactPasswordInText(input);
      expect(out).toContain(`password is "•••••• (7)"`);
    });

    it('Case 2: keyword ... (with|as|to|=) VALUE', () => {
      const input = `token=abcd1234 and auth with xyz`;
      const out = redactPasswordInText(input);
      expect(out).toContain(`token=•••••• (8)`);
      expect(out).toContain(`auth with •••••• (3)`);
    });

    it('Case 3: "VALUE" into sensitive target (#access)', () => {
      const input = `Type "Imp0st3r123!" into #access`;
      const out = redactPasswordInText(input);
      expect(out).toBe(`Type "•••••• (12)" into #access`);
    });

    it('non-sensitive text is unchanged', () => {
      const input = `Click the button and type "hello" into #search`;
      const out = redactPasswordInText(input);
      expect(out).toBe(input);
    });

    it('handles api key forms with spaces/underscores/hyphens', () => {
      const cases = [
        `api-key "abcDEF123"`,
        `api key "abcDEF123"`,
        `api_key "abcDEF123"`,
      ];
      for (const text of cases) {
        const out = redactPasswordInText(text);
        expect(out).toContain(`"•••••• (9)"`);
      }
    });
  });
});
