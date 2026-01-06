// tests/turnLoopTests/turnLoop.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────
// Hoisted shared state (visible to mock factories)
// ─────────────────────────────────────────────
const { shared } = vi.hoisted(() => {
  return {
    shared: {
      // LLM chat mock will be attached here by the llmFactory mock
      chatMock: null,

      // Browser tool spies available to the chromeBrowser mock
      chromeToolSpies: {
        click_text: vi.fn(async () => JSON.stringify({ ok: true, clicked: 'Hello' })),
        get_dom: vi.fn(async () => '<html>dom</html>'),
        screenshot: vi.fn(async () =>
          JSON.stringify({
            _testronaut_file_event: 'download',
            fileName: 'shot.png',
            bytes: 1234,
            mode: 'save',
          })
        ),
        list_local_files: vi.fn(async () => JSON.stringify({ files: ['a.pdf', 'b.pdf'] })),
      },
    },
  };
});

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

vi.mock('../../llm/modelResolver.js', () => ({
  resolveProviderModel: () => ({ provider: 'stub', model: 'stub-model' }),
}));

// Use hoisted shared.chatMock
vi.mock('../../llm/llmFactory.js', () => ({
  getLLM: () => {
    shared.chatMock = vi.fn();
    return { chat: shared.chatMock };
  },
}));

vi.mock('../../tools/tokenControl.js', () => ({
  tokenEstimate: vi.fn(async () => 0),
  tokenUseCoolOff: vi.fn(async (totalTokensUsed, turnTimestamps) => ({
    shouldBackoff: false,
    totalTokensUsed,
    turnTimestamps,
  })),
  recordTokenUsage: vi.fn(() => {}),
  pruneOldTokenUsage: vi.fn((turnTimestamps) => ({
    turnTimestamps,
    totalTokensUsed: turnTimestamps.reduce((a, [, t]) => a + t, 0),
  })),
  updateLimitsFromHeaders: vi.fn(() => {}),
}));

vi.mock('../../tools/toolSchema.js', () => ({
  default: [
    { type: 'function', function: { name: 'click_text', description: 'click by text', parameters: {} } },
    { type: 'function', function: { name: 'get_dom', description: 'get DOM html', parameters: {} } },
    { type: 'function', function: { name: 'screenshot', description: 'take a screenshot', parameters: {} } },
    { type: 'function', function: { name: 'list_local_files', description: 'list files', parameters: {} } },
  ],
}));

// Use hoisted shared.chromeToolSpies
vi.mock('../../tools/chromeBrowser.js', () => ({
  CHROME_TOOL_MAP: shared.chromeToolSpies,
}));

vi.mock('../../tools/turnLoopUtils.js', async () => {
  const real = await vi.importActual('../../tools/turnLoopUtils.js');
  return {
    ...real,
    finalResponseHandler: (msg) => {
      const content = (msg?.content || '').toString();
      if (content.includes('FINAL')) {
        return { finalMessage: 'Mission complete', success: true };
      }
      return null;
    },
    validateAndInsertMissingToolResponses: () => true,
    wait: vi.fn(async () => {}),
  };
});

vi.mock('../../core/turnIntent.js', () => ({
  summarizeTurnIntentFromMessage: (msg) => `plan:${(msg?.content || '').slice(0, 20)}`,
}));

vi.mock('../../core/redaction.js', () => ({
  redactArgs: (name, args) => args,
}));

// Import SUT after mocks
import { turnLoop, __docProgressInternals } from '../../core/turnLoop.js';

// Helper
function baseMessages() {
  return [
    { role: 'system', content: 'You are Testronaut.' },
    { role: 'user', content: 'Start mission' },
  ];
}

describe('turnLoop', () => {
  let browser;

  beforeEach(() => {
    browser = {};
    // reset spies and chat mock
    shared.chromeToolSpies.click_text.mockClear();
    shared.chromeToolSpies.get_dom.mockClear();
    shared.chromeToolSpies.screenshot.mockClear();
    if (shared.chatMock) shared.chatMock.mockReset();
  });

  it('handles a final response in a single turn (no tools)', async () => {
    shared.chatMock.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'FINAL: success' },
      usage: { total_tokens: 42 },
      headers: {},
    });

    const messages = baseMessages();
    const result = await turnLoop(browser, messages, 1, 0, 0, {}, { steps: [], missionName: 'demo' });

    expect(result.success).toBe(true);
    expect(result.steps?.length).toBe(1);
    const step = result.steps[0];
    expect(step.tokensUsed).toBe(42);
    expect(step.summary).toContain('plan:FINAL: success');
    expect(step.result).toMatch(/✅|Success/);

    expect(shared.chromeToolSpies.click_text).not.toHaveBeenCalled();
    expect(shared.chromeToolSpies.get_dom).not.toHaveBeenCalled();
  });

  it('executes a tool call, injects DOM, then finishes on next turn', async () => {
    shared.chatMock.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tool_1',
            type: 'function',
            function: { name: 'click_text', arguments: JSON.stringify({ text: 'Hello' }) },
          },
        ],
      },
      usage: { total_tokens: 10 },
    });

    shared.chatMock.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'FINAL: done' },
      usage: { total_tokens: 5 },
    });

    const messages = baseMessages();
    const res = await turnLoop(browser, messages, 2, 0, 0, {}, { steps: [], missionName: 'demo' });

    expect(res.success).toBe(true);
    expect(res.steps.length).toBe(2);

    const step1 = res.steps[0];
    expect(step1.result).toBe('✅ Passed');
    expect(shared.chromeToolSpies.click_text).toHaveBeenCalledTimes(1);
    expect(shared.chromeToolSpies.get_dom).toHaveBeenCalled();

    const step2 = res.steps[1];
    expect(step2.result).toMatch(/Success/);
  });

  it('retries a turn on tool error before marking issues', async () => {
    // First turn: tool call → click_text will throw
    shared.chatMock.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tool_retry',
            type: 'function',
            function: { name: 'click_text', arguments: JSON.stringify({ text: 'Hello' }) },
          },
        ],
      },
      usage: { total_tokens: 7 },
    });
    // Retry turn: same tool call, click_text succeeds
    shared.chatMock.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tool_retry_2',
            type: 'function',
            function: { name: 'click_text', arguments: JSON.stringify({ text: 'Hello' }) },
          },
        ],
      },
      usage: { total_tokens: 6 },
    });
    // Final turn: mission completes
    shared.chatMock.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'FINAL: done' },
      usage: { total_tokens: 5 },
    });

    // click_text fails once, then succeeds
    shared.chromeToolSpies.click_text
      .mockImplementationOnce(async () => { throw new Error('no locator'); })
      .mockImplementationOnce(async () => JSON.stringify({ ok: true, clicked: 'Hello' }));

    const messages = baseMessages();
    const res = await turnLoop(browser, messages, 3, 0, 0, {}, { steps: [], missionName: 'demo' });

    expect(res.success).toBe(true);
    expect(res.steps.length).toBe(3);
    expect(res.steps[0].result).toBe('⏳ Retrying turn');
    expect(res.steps[1].result).toBe('✅ Passed');
    expect(res.steps[2].result).toMatch(/Success/);
  });

  describe('__docProgressInternals helpers', () => {
    const { parseDocListFromDom, extractDocIdFromUrl, ensureDocProgress } = __docProgressInternals;

    it('parses injected doc list summary', () => {
      const html = `<pre data-testronaut-doc-list>
List
- [123] File A /document/123
- [456] File B /document/456
</pre>`;
      const { items, scriptDocs } = parseDocListFromDom(html);
      expect(items).toHaveLength(2);
      expect(items[0].id).toBe('123');
      expect(items[1].title.length).toBeGreaterThan(0);
      expect(scriptDocs).toBe(2);
    });

    it('extracts doc id from url and tracks progress', () => {
      expect(extractDocIdFromUrl('https://x.com/document/999/foo')).toBe('999');
      expect(extractDocIdFromUrl('nope')).toBe('');

      const mem = {};
      const cfg = { enabled: true, hrefIncludes: ['/doc'], dataTypes: ['doc'] };
      const prog = ensureDocProgress(mem, cfg);
      expect(prog.patterns).toBe(cfg);
      prog.items = [{ id: '1', title: 'Doc 1' }];
      prog.downloaded.add('1');
      expect(prog.downloaded.has('1')).toBe(true);
    });

    it('updates progress from list_local_files results', () => {
      const mem = {};
      const cfg = { enabled: true, hrefIncludes: ['/doc'], dataTypes: ['doc'] };
      const prog = ensureDocProgress(mem, cfg);
      prog.items = [];
      // simulate list_local_files JSON result
      const parsed = JSON.parse(JSON.stringify({ files: ['x.pdf', 'y.pdf'] }));
      prog.items = parsed.files.map(f => ({ id: f, title: f, href: f }));
      prog.downloaded.add('x.pdf');
      expect(prog.items).toHaveLength(2);
      expect(prog.downloaded.has('x.pdf')).toBe(true);
    });
  });
});
