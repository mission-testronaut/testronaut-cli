import { describe, expect, it, vi } from 'vitest';
import { ChromeBrowser } from '../../tools/chromeBrowser.js';

describe('ChromeBrowser.click_text', () => {
  it('clicks the first visible innermost exact-text match with a short timeout', async () => {
    const hidden = {
      isVisible: vi.fn().mockResolvedValue(false),
    };
    const visible = {
      isVisible: vi.fn().mockResolvedValue(true),
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const matches = {
      count: vi.fn().mockResolvedValue(2),
      nth: vi.fn(index => [hidden, visible][index]),
    };
    const browser = Object.create(ChromeBrowser.prototype);
    browser.page = {
      getByText: vi.fn().mockReturnValue(matches),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await expect(browser.click_text({ text: 'Report' })).resolves.toBe('clicked text "Report"');
    expect(browser.page.getByText).toHaveBeenCalledWith('Report', { exact: true });
    expect(visible.click).toHaveBeenCalledWith({ timeout: 3000 });
    expect(browser.page.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('does not fall back to a partial or hidden match', async () => {
    const matches = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
    };
    const browser = Object.create(ChromeBrowser.prototype);
    browser.page = {
      getByText: vi.fn().mockReturnValue(matches),
      waitForTimeout: vi.fn(),
    };

    await expect(browser.click_text({ text: 'Add' })).rejects.toThrow('Exact visible text "Add" not found');
    expect(browser.page.getByText).toHaveBeenCalledWith('Add', { exact: true });
  });
});

describe('ChromeBrowser.check_text', () => {
  it('reports text when at least one matching element is visible', async () => {
    const matches = {
      count: vi.fn().mockResolvedValue(2),
      nth: vi.fn(index => [
        { isVisible: vi.fn().mockResolvedValue(false) },
        { isVisible: vi.fn().mockResolvedValue(true) },
      ][index]),
    };
    const browser = Object.create(ChromeBrowser.prototype);
    browser.page = { getByText: vi.fn().mockReturnValue(matches) };

    await expect(browser.check_text({ text: 'Signed out' })).resolves.toBe('FOUND: Signed out');
    expect(browser.page.getByText).toHaveBeenCalledWith('Signed out');
  });

  it('does not report text that only exists in hidden elements', async () => {
    const matches = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
    };
    const browser = Object.create(ChromeBrowser.prototype);
    browser.page = { getByText: vi.fn().mockReturnValue(matches) };

    await expect(browser.check_text({ text: 'Hidden message' })).resolves.toBe('NOT FOUND: Hidden message');
  });

  it('reports the iframe containing a visible match', async () => {
    const noMatches = { count: vi.fn().mockResolvedValue(0) };
    const frameMatches = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(true) }),
    };
    const mainFrame = { getByText: vi.fn().mockReturnValue(noMatches) };
    const childFrame = {
      getByText: vi.fn().mockReturnValue(frameMatches),
      name: vi.fn().mockReturnValue(''),
      frameElement: vi.fn().mockResolvedValue({ getAttribute: vi.fn().mockResolvedValue('webviewer-1') }),
      url: vi.fn().mockReturnValue('https://example.test/viewer'),
    };
    const browser = Object.create(ChromeBrowser.prototype);
    browser.page = {
      mainFrame: vi.fn().mockReturnValue(mainFrame),
      frames: vi.fn().mockReturnValue([mainFrame, childFrame]),
    };

    await expect(browser.check_text({ text: 'Quarterly report' }))
      .resolves.toBe('FOUND in frame webviewer-1: Quarterly report');
  });
});

describe('ChromeBrowser iframe interaction targeting', () => {
  it('builds an explicit frame-qualified click locator', () => {
    const locator = { first: vi.fn().mockReturnThis() };
    const frameContext = { locator: vi.fn().mockReturnValue(locator) };
    const browser = Object.create(ChromeBrowser.prototype);
    browser.page = { frameLocator: vi.fn().mockReturnValue(frameContext) };

    const [make] = browser._buildClickCandidates({
      frame: 'iframe#webviewer-1', selector: 'button[aria-label="Settings"]', searchAllFrames: true,
    });

    expect(make()).toBe(locator);
    expect(browser.page.frameLocator).toHaveBeenCalledWith('iframe#webviewer-1');
    expect(frameContext.locator).toHaveBeenCalledWith('button[aria-label="Settings"]');
  });
});
