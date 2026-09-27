const completedProtocols = new Set();

/**
 * Add optional shared-session reuse metadata to an ordinary mission goal.
 * The wrapped goal remains string-coercible for backward compatibility.
 */
export function launchProtocol(goal, { id, probe } = {}) {
  const protocolId = String(id || '').trim();
  if (!protocolId) throw new Error('launchProtocol requires a non-empty id.');
  if (!probe || (!probe.selector && !probe.text)) {
    throw new Error('launchProtocol requires a probe selector or text value.');
  }

  return Object.freeze({
    __testronautLaunchProtocol: true,
    goal,
    protocol: Object.freeze({
      id: protocolId,
      probe: Object.freeze({ ...probe }),
    }),
    toString() {
      return typeof goal === 'string' ? goal : goal?.toString?.() ?? String(goal);
    },
  });
}

export function unwrapLaunchProtocol(value) {
  if (!value?.__testronautLaunchProtocol) return { goal: value, protocol: null };
  return { goal: value.goal, protocol: value.protocol };
}

export function hasCompletedLaunchProtocol(id) {
  return completedProtocols.has(id);
}

export function markLaunchProtocolCompleted(id) {
  completedProtocols.add(id);
}

export function resetLaunchProtocols() {
  completedProtocols.clear();
}
