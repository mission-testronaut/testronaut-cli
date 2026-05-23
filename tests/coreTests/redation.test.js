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

    it('masks human input tool values', () => {
      const args = { prompt: 'Enter code', value: '123456', code: '654321' };
      const redacted = redactArgs('request_human_input', args);
      expect(redacted.prompt).toBe('Enter code');
      expect(redacted.value).toBe('•••••• (6)');
      expect(redacted.code).toBe('•••••• (6)');
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

    it('masks MFA codes mentioned as entered in final text', () => {
      const input = `SUCCESS: Logged in as ISAAC, completed MFA (entered 123456), and reached the dashboard.`;
      const out = redactPasswordInText(input);
      expect(out).toContain(`MFA (entered •••••• (6))`);
      expect(out).not.toContain('123456');
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

    it('does not mangle MFA mission instructions while masking the access value', () => {
      const input = `Fill the access code field (#access) with sword.
Check the "Challenge with MFA code" checkbox.
Set MFA code digits to 8.
There should be an MFA challenge. Prompt the user for an MFA code, then fill the MFA Code field (#mfa-code) with that code.
Click the "Verify Code" button (#mfa-submit).`;
      const out = redactPasswordInText(input);
      expect(out).toContain('Fill the access code field (#access) with •••••• (5)');
      expect(out).toContain('Check the "Challenge with MFA code" checkbox.');
      expect(out).toContain('Set MFA code digits to 8.');
      expect(out).toContain('with that code.');
      expect(out).toContain('Click the "Verify Code" button (#mfa-submit).');
      expect(out).not.toContain('sword');
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
