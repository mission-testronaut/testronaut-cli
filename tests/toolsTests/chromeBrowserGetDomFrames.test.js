import { describe, expect, it, vi } from 'vitest';
import { ChromeBrowser } from '../../tools/chromeBrowser.js';

describe('ChromeBrowser.get_dom iframe serialization', () => {
  it('keeps serialized same-origin content and inaccessible-frame markers', async () => {
    const browser = Object.create(ChromeBrowser.prototype);
    browser.domListLimit = 3;
    browser.debugEnabled = false;
    browser.context = null;
    browser.page = {
      isClosed: vi.fn().mockReturnValue(false),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body></body></html>'),
      evaluate: vi.fn().mockResolvedValue(`
        <html><body>
          <testronaut-frame id="viewer" data-testronaut-frame="viewer" data-testronaut-frame-status="same-origin">
            <html><body><button aria-label="Settings">Settings</button><p>Quarterly report</p></body></html>
          </testronaut-frame>
          <testronaut-frame id="payment" data-testronaut-frame="payment" data-testronaut-frame-status="cross-origin">
            [cross-origin frame, content not accessible]
          </testronaut-frame>
        </body></html>`),
    };

    const result = await browser.get_dom();

    expect(result).toContain('data-testronaut-frame="viewer"');
    expect(result).toContain('<iframe');
    expect(result).toContain('Quarterly report');
    expect(result).toContain('aria-label="Settings"');
    expect(result).toContain('[cross-origin frame, content not accessible]');
  });
});
