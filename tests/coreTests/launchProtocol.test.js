import { describe, expect, it, beforeEach } from 'vitest';
import {
  launchProtocol,
  unwrapLaunchProtocol,
  hasCompletedLaunchProtocol,
  markLaunchProtocolCompleted,
  resetLaunchProtocols,
} from '../../core/launchProtocol.js';

describe('launchProtocol', () => {
  beforeEach(() => resetLaunchProtocols());

  it('wraps ordinary mission text without changing string coercion', () => {
    const wrapped = launchProtocol('Log in', {
      id: 'authenticated:user',
      probe: { url: 'https://example.test', selector: '#dashboard' },
    });
    expect(String(wrapped)).toBe('Log in');
    expect(unwrapLaunchProtocol(wrapped)).toEqual({
      goal: 'Log in',
      protocol: {
        id: 'authenticated:user',
        probe: { url: 'https://example.test', selector: '#dashboard' },
      },
    });
  });

  it('tracks completed protocol ids for one process run', () => {
    expect(hasCompletedLaunchProtocol('auth')).toBe(false);
    markLaunchProtocolCompleted('auth');
    expect(hasCompletedLaunchProtocol('auth')).toBe(true);
  });

  it('rejects incomplete metadata', () => {
    expect(() => launchProtocol('x', { probe: { selector: '#ready' } })).toThrow(/id/);
    expect(() => launchProtocol('x', { id: 'ready', probe: {} })).toThrow(/selector or text/);
  });
});
