import { describe, it, expect, vi } from 'vitest';
import { finalResponseHandler } from '../../tools/turnLoopUtils.js';

describe('tools/turnLoopUtils', () => {
  it('redacts verification codes before printing and returning final responses', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = finalResponseHandler({
        content: 'SUCCESS: Logged in, completed MFA (entered 123456), and reached the dashboard.',
      });

      expect(result).toMatchObject({ success: true });
      expect(result.finalMessage).toContain('MFA (entered •••••• (6))');
      expect(result.finalMessage).not.toContain('123456');

      const printed = logSpy.mock.calls.flat().join('\n');
      expect(printed).toContain('MFA (entered •••••• (6))');
      expect(printed).not.toContain('123456');
    } finally {
      logSpy.mockRestore();
    }
  });
});
