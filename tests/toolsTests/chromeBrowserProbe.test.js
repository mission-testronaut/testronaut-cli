import { describe, expect, it, vi } from 'vitest';
import { ChromeBrowser } from '../../tools/chromeBrowser.js';

function makeBrowser({ visible = true, content = 'Mission Tasks' } = {}) {
  const locator = {
    first: () => locator,
    waitFor: vi.fn(() => visible ? Promise.resolve() : Promise.reject(new Error('not visible'))),
    textContent: vi.fn().mockResolvedValue(content),
  };
  const browser = Object.create(ChromeBrowser.prototype);
  browser.page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn(() => locator),
    url: vi.fn(() => 'https://example.test/dashboard'),
  };
  return { browser, locator };
}

describe('ChromeBrowser.probe', () => {
  it('passes after navigating when selector and text match', async () => {
    const { browser } = makeBrowser();
    await expect(browser.probe({
      url: 'https://example.test',
      selector: '#dashboard',
      text: 'Mission Tasks',
    })).resolves.toMatchObject({ passed: true });
    expect(browser.page.goto).toHaveBeenCalledWith('https://example.test', expect.any(Object));
  });

  it('fails without invoking an agent when the selector is not visible', async () => {
    const { browser } = makeBrowser({ visible: false });
    await expect(browser.probe({ selector: '#dashboard' })).resolves.toMatchObject({
      passed: false,
      reason: 'selector not visible: #dashboard',
    });
  });
});
