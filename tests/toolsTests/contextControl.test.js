// tests/toolsTests/contextControl.test.js
/**
 * contextControl.test.js
 * ----------------------
 * Purpose:
 *   Unit tests for conversation context utilities:
 *   - sanitizeHeavyToolHistory: stubs older heavy tool results to shrink token load.
 *   - pruneConversationContext: trims message history while preserving tool-call structure.
 *
 * Design goals:
 *   - Verify that heavy tool messages (e.g., get_dom) are preserved for recent calls
 *     and stubbed for older ones.
 *   - Ensure pruning never produces a "tool without parent tool_calls" shape that
 *     would violate the OpenAI-style tool-calling protocol.
 *
 * Related tests:
 *   Located in `tests/toolsTests/`
 *
 * Used by:
 *   - core/turnLoop.js (before calling llm.chat)
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeHeavyToolHistory,
  pruneConversationContext,
  createEmptyGroundControl,
  applyGroundControlUpdate,
  recordGroundTelemetry,
  summarizeGroundControlForPrompt
} from '../../tools/contextControl.js';

describe('sanitizeHeavyToolHistory', () => {
  it('stubs older get_dom tool messages but keeps the latest N intact', () => {
    const messages = [
      { role: 'tool', name: 'get_dom', content: '<html>old-1</html>' }, // should stub
      { role: 'tool', name: 'get_dom', content: '<html>old-2</html>' }, // should stub
      { role: 'tool', name: 'get_dom', content: '<html>keep-1</html>' }, // keep
      { role: 'tool', name: 'get_dom', content: '<html>keep-2</html>' }, // keep
    ];

    sanitizeHeavyToolHistory(messages, { keepRecentPerTool: 2 });

    // Older ones should be replaced with a stub
    expect(messages[0].content).toBe('[get_dom output omitted for brevity – older snapshot]');
    expect(messages[1].content).toBe('[get_dom output omitted for brevity – older snapshot]');

    // Latest ones should be preserved
    expect(messages[2].content).toBe('<html>keep-1</html>');
    expect(messages[3].content).toBe('<html>keep-2</html>');
  });

  it('does not touch non-heavy tool messages', () => {
    const messages = [
      { role: 'tool', name: 'get_dom', content: '<html>dom</html>' },
      { role: 'tool', name: 'screenshot', content: 'Screenshot saved at: ./screenshots/foo.png' },
      { role: 'assistant', content: 'Something else' },
    ];

    sanitizeHeavyToolHistory(messages, { keepRecentPerTool: 1 });

    // get_dom may be stubbed depending on index, but screenshot must not be altered
    expect(messages[1].content).toBe(
      'Screenshot saved at: ./screenshots/foo.png',
    );
    // Sanity check: roles unchanged
    expect(messages[2].role).toBe('assistant');
  });

  it('is safe when there are no heavy tool messages', () => {
    const messages = [
      { role: 'assistant', content: 'hello' },
      { role: 'tool', name: 'screenshot', content: 'Screenshot saved at: ./screenshots/foo.png' },
    ];

    const clone = JSON.parse(JSON.stringify(messages));
    sanitizeHeavyToolHistory(messages, { keepRecentPerTool: 2 });

    // No mutation expected because there are no get_dom messages
    expect(messages).toEqual(clone);
  });

  it('handles empty conversations gracefully', () => {
    const messages = [];
    sanitizeHeavyToolHistory(messages, { keepRecentPerTool: 2 });
    expect(messages).toEqual([]);
  });
});

describe('pruneConversationContext', () => {
  it('always keeps all system messages, even if over the non-system limit', () => {
    const messages = [
      { role: 'system', content: 'sys-1' },
      { role: 'system', content: 'sys-2' },
      { role: 'user', content: 'u-1' },
      { role: 'assistant', content: 'a-1' },
      { role: 'user', content: 'u-2' },
      { role: 'assistant', content: 'a-2' },
    ];

    const pruned = pruneConversationContext(messages, { maxNonSystemMessages: 2 });

    // All system messages must be present
    expect(pruned.filter(m => m.role === 'system').length).toBe(2);

    // Only the last 2 non-system messages should be kept: a-2 and u-2 or similar ordering
    const nonSystem = pruned.filter(m => m.role !== 'system');
    expect(nonSystem.length).toBeLessThanOrEqual(2);
    expect(nonSystem.map(m => m.content)).toEqual(['u-2', 'a-2']);
  });

  it('drops tool messages whose parent assistant tool_calls were pruned', () => {
    const messages = [
      // Old assistant + tool (should be pruned)
      {
        role: 'assistant',
        content: 'old tool call',
        tool_calls: [
          { id: 'call-old', type: 'function', function: { name: 'get_dom', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-old',
        name: 'get_dom',
        content: '<html>old</html>',
      },

      // Newer assistant + tool (should survive)
      {
        role: 'assistant',
        content: 'new tool call',
        tool_calls: [
          { id: 'call-new', type: 'function', function: { name: 'get_dom', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-new',
        name: 'get_dom',
        content: '<html>new</html>',
      },
    ];

    // Limit window so only the newer pair fits in the tail
    const pruned = pruneConversationContext(messages, { maxNonSystemMessages: 3 });

    // The tool referencing "call-old" should be gone
    const toolCallIds = pruned
      .filter(m => m.role === 'tool')
      .map(m => m.tool_call_id);

    expect(toolCallIds).toContain('call-new');
    expect(toolCallIds).not.toContain('call-old');

    // The assistant for "call-new" must still be present
    const hasNewAssistant = pruned.some(
      m => m.role === 'assistant' &&
           Array.isArray(m.tool_calls) &&
           m.tool_calls.some(tc => tc.id === 'call-new'),
    );
    expect(hasNewAssistant).toBe(true);
  });

  it('drops tool messages without tool_call_id defensively', () => {
    const messages = [
      { role: 'assistant', content: 'plain reply' },
      { role: 'tool', name: 'get_dom', content: '<html>no id</html>' }, // invalid shape
    ];

    const pruned = pruneConversationContext(messages, { maxNonSystemMessages: 5 });

    // Tool with no tool_call_id should not be present
    expect(pruned.some(m => m.role === 'tool')).toBe(false);
  });

  it('keeps a valid assistant+tool pair when both fit in the tail', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'tool call',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'get_dom', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'get_dom',
        content: '<html>dom</html>',
      },
      { role: 'assistant', content: 'follow-up' },
    ];

    const pruned = pruneConversationContext(messages, { maxNonSystemMessages: 4 });

    // Both assistant and tool should be present
    const hasAssistant = pruned.some(
      m => m.role === 'assistant' &&
           Array.isArray(m.tool_calls) &&
           m.tool_calls.some(tc => tc.id === 'call-1'),
    );
    const hasTool = pruned.some(
      m => m.role === 'tool' && m.tool_call_id === 'call-1',
    );

    expect(hasAssistant).toBe(true);
    expect(hasTool).toBe(true);
  });

  it('handles empty and small conversations without modification surprises', () => {
    const empty = [];
    const prunedEmpty = pruneConversationContext(empty, { maxNonSystemMessages: 5 });
    expect(prunedEmpty).toEqual([]);

    const small = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const prunedSmall = pruneConversationContext(small, { maxNonSystemMessages: 10 });
    expect(prunedSmall).toEqual(small);
  });
});

describe('createEmptyGroundControl', () => {
  it('creates a normalized empty structure with expected top-level keys', () => {
    const gc = createEmptyGroundControl();

    expect(gc).toBeTruthy();
    expect(gc).toHaveProperty('app');
    expect(gc).toHaveProperty('session');
    expect(gc).toHaveProperty('navigation');
    expect(gc).toHaveProperty('constraints');
    expect(gc).toHaveProperty('telemetry');

    expect(gc.app).toEqual({
      baseUrl: null,
      currentUrl: null,
      routeRole: null,
    });
    expect(gc.session).toEqual({
      loggedIn: null,
      userLabel: null,
      tenant: null,
    });
    expect(gc.navigation).toEqual({
      currentLabel: null,
    });
    expect(gc.constraints).toEqual({
      stayWithinBaseUrl: null,
    });
    expect(Array.isArray(gc.telemetry)).toBe(true);
    expect(gc.telemetry.length).toBe(0);
  });
});

describe('applyGroundControlUpdate', () => {
  it('applies a full update across app, session, navigation, and constraints', () => {
    const gc = createEmptyGroundControl();

    const payload = {
      app: {
        baseUrl: 'https://example.com',
        currentUrl: 'https://example.com/dashboard',
        routeRole: 'dashboard',
      },
      session: {
        loggedIn: true,
        userLabel: 'Demo User',
        tenant: 'acme-tenant',
      },
      navigation: {
        currentLabel: 'Main dashboard',
      },
      constraints: {
        stayWithinBaseUrl: true,
      },
    };

    const result = applyGroundControlUpdate(gc, payload);

    // Should mutate the same reference and return it for chaining
    expect(result).toBe(gc);

    expect(gc.app).toEqual({
      baseUrl: 'https://example.com',
      currentUrl: 'https://example.com/dashboard',
      routeRole: 'dashboard',
    });

    expect(gc.session).toEqual({
      loggedIn: true,
      userLabel: 'Demo User',
      tenant: 'acme-tenant',
    });

    expect(gc.navigation).toEqual({
      currentLabel: 'Main dashboard',
    });

    expect(gc.constraints).toEqual({
      stayWithinBaseUrl: true,
    });
  });

  it('merges partial updates without clobbering existing values', () => {
    const gc = createEmptyGroundControl();

    applyGroundControlUpdate(gc, {
      app: {
        baseUrl: 'https://example.com',
        currentUrl: 'https://example.com/login',
      },
      session: {
        loggedIn: false,
      },
    });

    // Second update only changes currentUrl + navigation label
    applyGroundControlUpdate(gc, {
      app: {
        currentUrl: 'https://example.com/chat',
      },
      navigation: {
        currentLabel: 'Chat page',
      },
    });

    expect(gc.app.baseUrl).toBe('https://example.com');
    expect(gc.app.currentUrl).toBe('https://example.com/chat'); // updated
    expect(gc.app.routeRole).toBeNull();                        // untouched

    expect(gc.session.loggedIn).toBe(false);                    // preserved
    expect(gc.session.userLabel).toBeNull();                    // untouched

    expect(gc.navigation.currentLabel).toBe('Chat page');
  });

  it('ignores unknown keys in the payload defensively', () => {
    const gc = createEmptyGroundControl();

    applyGroundControlUpdate(gc, {
      app: {
        baseUrl: 'https://example.com',
      },
      // @ts-expect-error - unknown key should be ignored
      unknownSection: {
        foo: 'bar',
      },
    });

    expect(gc.app.baseUrl).toBe('https://example.com');
    // No accidental additions
    // @ts-expect-error - unknownSection should not exist
    expect(gc.unknownSection).toBeUndefined();
  });

  it('throws if called without an existing groundControl object', () => {
    expect(() => applyGroundControlUpdate(null, { app: { baseUrl: 'x' } }))
      .toThrow(/applyGroundControlUpdate called without an existing groundControl state/i);
  });

  it('accepts explicit null for loggedIn and stayWithinBaseUrl', () => {
    const gc = createEmptyGroundControl();

    applyGroundControlUpdate(gc, {
      session: {
        loggedIn: null,
      },
      constraints: {
        stayWithinBaseUrl: null,
      },
    });

    expect(gc.session.loggedIn).toBeNull();
    expect(gc.constraints.stayWithinBaseUrl).toBeNull();
  });
});

describe('recordGroundTelemetry', () => {
  it('records a well-formed telemetry entry with default status and timestamp', () => {
    const gc = createEmptyGroundControl();

    const entry = {
      kind: 'breadcrumb',
      text: 'Landed on main dashboard',
    };

    const meta = { turn: 3 };

    const recorded = recordGroundTelemetry(gc, entry, meta);

    expect(recorded).toBeTruthy();
    expect(recorded.kind).toBe('breadcrumb');
    expect(recorded.text).toBe('Landed on main dashboard');
    expect(recorded.status).toBe('n/a'); // default
    expect(recorded.turn).toBe(3);

    // ts should look like an ISO string
    expect(typeof recorded.ts).toBe('string');
    expect(recorded.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(gc.telemetry.length).toBe(1);
    expect(gc.telemetry[0]).toEqual(recorded);
  });

  it('honors explicit status and supports multiple telemetry entries', () => {
    const gc = createEmptyGroundControl();

    const first = recordGroundTelemetry(gc, {
      kind: 'assertion',
      text: 'User appears logged in',
      status: 'passed',
    }, { turn: 1 });

    const second = recordGroundTelemetry(gc, {
      kind: 'issue',
      text: 'Unexpected redirect away from base URL',
      status: 'failed',
    }, { turn: 4 });

    expect(gc.telemetry.length).toBe(2);

    expect(first.status).toBe('passed');
    expect(second.status).toBe('failed');

    // Ensure both entries are in the telemetry array in order
    expect(gc.telemetry[0]).toEqual(first);
    expect(gc.telemetry[1]).toEqual(second);
  });

  it('returns null and does not push when kind or text is missing', () => {
    const gc = createEmptyGroundControl();

    const badNoKind = recordGroundTelemetry(gc, {
      // @ts-expect-error - intentional malformed entry
      text: 'Missing kind',
    }, { turn: 1 });

    const badNoText = recordGroundTelemetry(gc, {
      // @ts-expect-error - intentional malformed entry
      kind: 'note',
    }, { turn: 2 });

    expect(badNoKind).toBeNull();
    expect(badNoText).toBeNull();
    expect(gc.telemetry.length).toBe(0);
  });

  it('throws if called without an existing groundControl object', () => {
    expect(() => recordGroundTelemetry(null, {
      kind: 'note',
      text: 'Should fail',
    })).toThrow(/recordGroundTelemetry called without an existing groundControl state/i);
  });
});

describe('summarizeGroundControlForPrompt', () => {
  it('returns null when there is no meaningful signal', () => {
    expect(summarizeGroundControlForPrompt(undefined)).toBeNull();
    expect(summarizeGroundControlForPrompt(null)).toBeNull();
    expect(summarizeGroundControlForPrompt({})).toBeNull();

    // Empty but correctly-shaped GC should also yield null
    const emptyGc = {
      app: {},
      session: {},
      navigation: {},
      telemetry: [],
    };
    expect(summarizeGroundControlForPrompt(emptyGc)).toBeNull();
  });

  it('emits a compact snapshot when baseUrl is present', () => {
    const gc = {
      app: {
        baseUrl: 'https://example.com',
        currentUrl: 'https://example.com/login',
        routeRole: 'login',
      },
      session: {
        loggedIn: true,
        userLabel: 'Demo User',
      },
      navigation: {
        currentLabel: 'Login page',
      },
      telemetry: [
        { kind: 'breadcrumb', text: 'Loaded login page', status: 'n/a' },
      ],
    };

    const snapshot = summarizeGroundControlForPrompt(gc);
    expect(snapshot).toBeTruthy();

    expect(snapshot.app).toEqual({
      baseUrl: 'https://example.com',
      currentUrl: 'https://example.com/login',
    });

    expect(snapshot.session).toEqual({
      loggedIn: true,
      userLabel: 'Demo User',
    });

    expect(snapshot.navigation).toEqual({
      routeRole: 'login',
      currentLabel: 'Login page',
    });

    expect(Array.isArray(snapshot.telemetryLines)).toBe(true);
    expect(snapshot.telemetryLines.length).toBe(1);
    expect(snapshot.telemetryLines[0]).toContain('[breadcrumb]');
    expect(snapshot.telemetryLines[0]).toContain('Loaded login page');
  });

  it('limits telemetryLines to the last 5 entries and formats status correctly', () => {
    const telemetry = [];
    for (let i = 0; i < 7; i++) {
      telemetry.push({
        kind: 'assertion',
        text: `check-${i}`,
        status: i % 2 === 0 ? 'passed' : 'failed',
      });
    }

    const gc = {
      app: { baseUrl: 'https://example.com' },
      session: {},
      navigation: {},
      telemetry,
    };

    const snapshot = summarizeGroundControlForPrompt(gc);
    expect(snapshot.telemetryLines.length).toBe(5);

    // Should be last 5: indices 2..6
    snapshot.telemetryLines.forEach((line, idx) => {
      const expectedIndex = idx + 2;
      expect(line).toContain(`check-${expectedIndex}`);
      expect(line).toContain('[assertion]');

      const shouldShowStatus = telemetry[expectedIndex].status !== 'n/a';
      if (shouldShowStatus) {
        expect(line).toContain(`(${telemetry[expectedIndex].status})`);
      }
    });
  });

  it('normalizes loggedIn to a boolean in the snapshot', () => {
    const gcTrue = {
      app: { baseUrl: 'https://example.com' },
      session: { loggedIn: true },
      navigation: {},
      telemetry: [],
    };
    const gcFalse = {
      app: { baseUrl: 'https://example.com' },
      session: { loggedIn: false },
      navigation: {},
      telemetry: [],
    };
    const gcNull = {
      app: { baseUrl: 'https://example.com' },
      session: { loggedIn: null },
      navigation: {},
      telemetry: [],
    };

    expect(summarizeGroundControlForPrompt(gcTrue)?.session.loggedIn).toBe(true);
    expect(summarizeGroundControlForPrompt(gcFalse)?.session.loggedIn).toBe(false);
    // null/undefined → false due to `!!` coercion
    expect(summarizeGroundControlForPrompt(gcNull)?.session.loggedIn).toBe(false);
  });

  it('uses routeRole from app and currentLabel from navigation', () => {
    const gc = {
      app: {
        baseUrl: 'https://example.com',
        routeRole: 'dashboard',
      },
      session: {},
      navigation: {
        currentLabel: 'Main dashboard',
      },
      telemetry: [],
    };

    const snapshot = summarizeGroundControlForPrompt(gc);
    expect(snapshot.navigation.routeRole).toBe('dashboard');
    expect(snapshot.navigation.currentLabel).toBe('Main dashboard');
  });
});