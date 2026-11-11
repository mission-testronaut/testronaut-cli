import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CHROME_TOOL_MAP, ChromeBrowser } from '../../tools/chromeBrowser.js';

class FakePage extends EventEmitter {
  url() { return 'https://example.test/dialogs'; }
}

function fakeDialog(type, message, defaultValue = '') {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    accept: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ChromeBrowser JavaScript dialogs', () => {
  it.each([
    ['alert', 'accept', undefined],
    ['confirm', 'dismiss', undefined],
    ['prompt', 'accept', 'red crewmate'],
    ['beforeunload', 'accept', undefined],
  ])('handles an expected %s without blocking', async (type, action, input) => {
    const browser = new ChromeBrowser();
    const page = new FakePage();
    browser._addAndFocus(page);
    browser.prepare_dialog_response({
      type,
      action,
      input,
      messageIncludes: 'Emergency',
    });
    const dialog = fakeDialog(type, 'Emergency meeting!', input ? 'anonymous' : '');

    page.emit('dialog', dialog);
    await flush();

    expect(dialog[action]).toHaveBeenCalledOnce();
    if (input !== undefined) expect(dialog.accept).toHaveBeenCalledWith(input);
    const [event] = browser.drainDialogEvents();
    expect(event).toMatchObject({
      event: 'javascript_dialog',
      type,
      message: 'Emergency meeting!',
      action,
      matched: true,
      outcome: action,
    });
    expect(event).not.toHaveProperty('defaultValue');
    expect(event.defaultValueProvided).toBe(Boolean(input));
  });

  it('dismisses and reports an unexpected dialog while retaining a nonmatching rule', async () => {
    const browser = new ChromeBrowser();
    const page = new FakePage();
    browser._addAndFocus(page);
    browser.prepare_dialog_response({ type: 'confirm', action: 'accept', message: 'Expected' });
    const dialog = fakeDialog('confirm', 'Suspicious impostor dialog');

    page.emit('dialog', dialog);
    await flush();

    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(browser.dialogRules).toHaveLength(1);
    expect(browser.drainDialogEvents()[0]).toMatchObject({
      matched: false,
      action: 'dismiss',
      outcome: 'unexpected_dialog_dismissed',
    });
  });

  it('reports an armed response that times out', () => {
    vi.useFakeTimers();
    try {
      const browser = new ChromeBrowser();
      browser.prepare_dialog_response({ type: 'alert', action: 'accept', timeoutMs: 250 });
      vi.advanceTimersByTime(251);
      expect(browser.drainDialogEvents()[0]).toMatchObject({
        event: 'dialog_rule_expired',
        expectedType: 'alert',
        outcome: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unscoped prompt input and exposes the dispatcher', async () => {
    const browser = new ChromeBrowser();
    expect(() => browser.prepare_dialog_response({ type: 'confirm', action: 'accept', input: 'secret' }))
      .toThrow(/only supported.*prompt/i);

    const prepare_dialog_response = vi.fn().mockReturnValue({ armed: true });
    expect(CHROME_TOOL_MAP.prepare_dialog_response(
      { prepare_dialog_response },
      { type: 'alert', action: 'accept' },
    )).toEqual({ armed: true });
  });
});
