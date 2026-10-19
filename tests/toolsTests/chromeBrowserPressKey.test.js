import { describe, expect, it, vi } from 'vitest';
import { CHROME_TOOL_MAP, ChromeBrowser } from '../../tools/chromeBrowser.js';

describe('ChromeBrowser.press_key', () => {
  it('presses a key on the active page', async () => {
    const browser = new ChromeBrowser();
    browser.page = { keyboard: { press: vi.fn().mockResolvedValue(undefined) } };

    await expect(browser.press_key({ key: 'Escape' })).resolves.toBe('pressed Escape');
    expect(browser.page.keyboard.press).toHaveBeenCalledWith('Escape');
  });

  it('focuses a selected element before pressing Enter', async () => {
    const browser = new ChromeBrowser();
    const focus = vi.fn().mockResolvedValue(undefined);
    const first = vi.fn().mockReturnValue({ focus });
    browser.page = {
      locator: vi.fn().mockReturnValue({ first }),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(browser.press_key({ key: 'Enter', selector: '#email' }))
      .resolves.toBe('pressed Enter after focusing #email');

    expect(browser.page.locator).toHaveBeenCalledWith('#email');
    expect(first).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ timeout: 3000 });
    expect(browser.page.keyboard.press).toHaveBeenCalledWith('Enter');
    expect(focus.mock.invocationCallOrder[0])
      .toBeLessThan(browser.page.keyboard.press.mock.invocationCallOrder[0]);
  });

  it('is exposed through the browser tool dispatcher', async () => {
    const press_key = vi.fn().mockResolvedValue('pressed Control+B');
    await expect(CHROME_TOOL_MAP.press_key({ press_key }, { key: 'Control+B' }))
      .resolves.toBe('pressed Control+B');
    expect(press_key).toHaveBeenCalledWith({ key: 'Control+B' });
  });
});
