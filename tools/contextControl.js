// Tools whose *content* tends to be extremely large (DOM, etc.).
// We keep their existence in context, but can safely stub older payloads.
const HEAVY_SEMANTIC_TOOLS = new Set([
  'get_dom',
]);

/**
 * Safely prune/sanitize older heavy tool messages in the conversation.
 *
 * Goals:
 *   - Keep recent DOM snapshots intact (last few).
 *   - For older ones, keep the tool message but replace content with a stub.
 *
 * This preserves conversational structure while shrinking token load.
 *
 * @param {Array} messages - conversation history (mutated in-place).
 * @param {object} opts
 * @param {number} opts.keepRecentPerTool - how many latest tool results to keep verbatim
 */
export function sanitizeHeavyToolHistory(messages, { keepRecentPerTool = 2 } = {}) {
  // Track latest indices per tool name
  const indicesByTool = new Map();

  messages.forEach((m, idx) => {
    if (m.role === 'tool' && m.name && HEAVY_SEMANTIC_TOOLS.has(m.name)) {
      if (!indicesByTool.has(m.name)) indicesByTool.set(m.name, []);
      indicesByTool.get(m.name).push(idx);
    }
  });

  // For each tool, stub all but the last `keepRecentPerTool`
  for (const [toolName, indices] of indicesByTool.entries()) {
    const toStub = indices.slice(0, Math.max(0, indices.length - keepRecentPerTool));
    for (const i of toStub) {
      const msg = messages[i];
      msg.content = `[${toolName} output omitted for brevity – older snapshot]`;
    }
  }
}


/**
 * Prune overall conversation context to keep it within a bounded window.
 *
 * Strategy:
 *   - Always keep all system messages.
 *   - Start from the end and keep the last `maxNonSystemMessages` non-system messages.
 *   - Ensure protocol correctness:
 *       * If a tool message is kept, its parent assistant with matching tool_call_id
 *         must also be present in the kept window. Otherwise, drop that tool message.
 *
 * This avoids "tool message without preceding tool_calls" API errors.
 *
 * @param {Array} messages - conversation history
 * @param {object} opts
 * @param {number} opts.maxNonSystemMessages
 * @returns {Array} pruned messages (new array)
 */
export function pruneConversationContext(messages, { maxNonSystemMessages = 40 } = {}) {
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // Take last N non-system messages (raw window)
  const tail = nonSystem.slice(-maxNonSystemMessages);

  // Pass 1: build map of tool_call_id -> index of assistant in tail
  const assistantToolParents = new Map(); // tool_call_id -> index in tail
  tail.forEach((m, idx) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id) {
          assistantToolParents.set(tc.id, idx);
        }
      }
    }
  });

  // Pass 2: filter out tool messages that have no parent assistant in the tail
  const cleanedTail = [];
  for (const m of tail) {
    if (m.role === 'tool') {
      const toolId = m.tool_call_id;
      if (!toolId) {
        // Defensive: if there's no tool_call_id at all, drop it.
        continue;
      }
      if (!assistantToolParents.has(toolId)) {
        // Parent assistant with this tool_call_id not present in tail,
        // so keeping this tool message would violate the protocol. Drop it.
        continue;
      }
    }
    cleanedTail.push(m);
  }

  return [...systemMessages, ...cleanedTail];
}

/* ---------------- Ground Control state helpers ----------------
 * These helpers back the "set_ground_control_state" and "record_mission_telemetry"
 * tools. They are designed to:
 *   - Keep durable mission facts (URL, login state, constraints) outside
 *     the pruned chat window.
 *   - Accumulate a lightweight telemetry trail (breadcrumbs, assertions,
 *     issues, and notes) that can be surfaced in reports.
 */

/**
 * Create a normalized, empty Ground Control state object.
 * Safe to reuse per mission and to serialize into reports.
 *
 * @returns {object} groundControl
 */
export function createEmptyGroundControl() {
  return {
    app: {
      baseUrl: null,
      currentUrl: null,
      routeRole: null,      // e.g. "login", "chat", "dashboard"
    },
    session: {
      loggedIn: null,       // true/false/null (unknown)
      userLabel: null,      // "Demo user", "Shane Fast", etc.
      tenant: null,         // workspace / tenant label if applicable
    },
    navigation: {
      currentLabel: null,   // human label for where we are, e.g. "Main chat page"
    },
    constraints: {
      stayWithinBaseUrl: null, // if true, avoid leaving app.baseUrl unless told to
    },
    telemetry: [],             // array of { kind, text, status, ts, turn? }
  };
}

/**
 * Apply a partial update from the `set_ground_control_state` tool to the
 * existing Ground Control state.
 *
 * - Mutates the provided `groundControl` in-place for simplicity.
 * - Only merges known sections/keys; unknown keys are ignored defensively.
 *
 * @param {object} groundControl - existing state (will be mutated)
 * @param {object} payload - tool arguments from set_ground_control_state
 * @returns {object} the same groundControl reference (for chaining)
 */
export function applyGroundControlUpdate(groundControl, payload = {}) {
  if (!groundControl) {
    throw new Error('applyGroundControlUpdate called without an existing groundControl state');
  }

  // 🔐 Ensure sub-objects exist so we can safely assign into them
  groundControl.app = groundControl.app || {};
  groundControl.session = groundControl.session || {};
  groundControl.navigation = groundControl.navigation || {};
  groundControl.constraints = groundControl.constraints || {};

  const { app, session, navigation, constraints } = payload;

  if (app && typeof app === 'object') {
    groundControl.app.baseUrl = app.baseUrl ?? groundControl.app.baseUrl;
    groundControl.app.currentUrl = app.currentUrl ?? groundControl.app.currentUrl;
    groundControl.app.routeRole = app.routeRole ?? groundControl.app.routeRole;
  }

  if (session && typeof session === 'object') {
    if (typeof session.loggedIn === 'boolean' || session.loggedIn === null) {
      groundControl.session.loggedIn = session.loggedIn;
    }
    if (typeof session.userLabel === 'string') {
      groundControl.session.userLabel = session.userLabel;
    }
    if (typeof session.tenant === 'string') {
      groundControl.session.tenant = session.tenant;
    }
  }

  if (navigation && typeof navigation === 'object') {
    if (typeof navigation.currentLabel === 'string') {
      groundControl.navigation.currentLabel = navigation.currentLabel;
    }
  }

  if (constraints && typeof constraints === 'object') {
    if (typeof constraints.stayWithinBaseUrl === 'boolean' || constraints.stayWithinBaseUrl === null) {
      groundControl.constraints.stayWithinBaseUrl = constraints.stayWithinBaseUrl;
    }
  }

  return groundControl;
}

/**
 * Append a telemetry entry to Ground Control from the `record_mission_telemetry` tool.
 *
 * Each entry is small and durable, and can be surfaced in final mission reports.
 *
 * @param {object} groundControl - existing state (mutated in-place)
 * @param {object} entry - { kind, text, status? } from tool args
 * @param {object} meta - optional metadata (e.g., { turn })
 * @returns {object} the appended telemetry object
 */
export function recordGroundTelemetry(groundControl, entry, meta = {}) {
  if (!groundControl) {
    throw new Error('recordGroundTelemetry called without an existing groundControl state');
  }

  if (!groundControl.telemetry) {
    groundControl.telemetry = [];
  }

  const { kind, text, status } = entry || {};
  if (!kind || !text) {
    // Defensive: only record well-formed entries
    return null;
  }

  const telemetry = {
    kind,                         // 'breadcrumb' | 'assertion' | 'issue' | 'note'
    text,
    status: status || 'n/a',      // 'passed' | 'failed' | 'n/a'
    ts: new Date().toISOString(),
    ...meta,                      // e.g., { turn: 3 }
  };

  groundControl.telemetry.push(telemetry);
  return telemetry;
}

/**
 * Build a compact, model-friendly snapshot of Ground Control for use in prompts.
 *
 * Goals:
 *   - Keep *critical* durable facts (URL, login state, rough route/area)
 *     available between missions without dragging the full state into context.
 *   - Emit a very small object that can be safely JSON.stringified and injected
 *     into a system message or "Ground Control" note.
 *   - Return `null` when there is no meaningful signal yet, so callers can skip
 *     adding noise to the prompt.
 *
 * Shape of the snapshot:
 *   {
 *     app: {
 *       baseUrl: string | null,
 *       currentUrl: string | null,
 *     },
 *     session: {
 *       loggedIn: boolean,        // coerced with `!!` (null/undefined → false)
 *       userLabel: string | null,
 *     },
 *     navigation: {
 *       routeRole: string | null, // high-level role like "login", "chat", etc.
 *       currentLabel: string | null, // human label like "Main chat page"
 *     },
 *     telemetryLines: string[]    // up to 5 last telemetry entries, pre-formatted
 *   }
 *
 * @param {object} gc - Full Ground Control state as maintained by the tools.
 * @returns {object|null} A compact snapshot or `null` if there is no signal.
 */
export function summarizeGroundControlForPrompt(gc = {}) {
  if (!gc || typeof gc !== 'object') return null;

  const app = gc.app || {};
  const session = gc.session || {};
  const navigation = gc.navigation || {};
  const telemetry = Array.isArray(gc.telemetry) ? gc.telemetry : [];

  const routeRole = typeof navigation.routeRole === 'string'
    ? navigation.routeRole
    : (typeof app.routeRole === 'string' ? app.routeRole : null);
  const currentLabel = typeof navigation.currentLabel === 'string' ? navigation.currentLabel : null;

  // Only emit snapshot if we have at least *some* meaningful info
  const hasSignal =
    app.baseUrl ||
    app.currentUrl ||
    typeof session.loggedIn === 'boolean' ||
    routeRole ||
    currentLabel ||
    telemetry.length > 0;

  if (!hasSignal) return null;

  const telemetryLines = telemetry
    .slice(-5) // last 5 breadcrumbs max
    .map(t => {
        const statusSuffix = t.status && t.status !== 'n/a' ? ` (${t.status})` : '';
        return `- [${t.kind}]${statusSuffix} ${t.text}`;
    });

  return {
    app: {
      baseUrl: app.baseUrl || null,
      currentUrl: app.currentUrl || null,
    },
    session: {
      loggedIn: !!session.loggedIn,
      userLabel: session.userLabel || null,
    },
    navigation: {
      routeRole,
      currentLabel,
    },
    telemetryLines,
  };
}
