import { describe, expect, it } from 'vitest';
import { buildBrowserEvidence } from '../../core/browserEvidence.js';

describe('browser evidence', () => {
  it('extracts bounded structure without field values or URL secrets', () => {
    const evidence = buildBrowserEvidence(`
      <html><head><title>Mission Dashboard</title></head><body>
        <main><h1>Mission Tasks</h1><form><label for="access">Access code</label>
          <input id="access" name="access" type="password" value="super-secret" />
          <button>Sign in</button>
        </form></main>
        <a href="https://example.test/tasks?token=secret#private">Tasks</a>
        <p>private body content</p>
      </body></html>
    `, { url: 'https://example.test/dashboard?token=secret#private' });

    expect(evidence).toMatchObject({
      url: 'https://example.test/dashboard',
      title: 'Mission Dashboard',
      headings: ['Mission Tasks'],
      counts: { headings: 1, forms: 1, buttons: 1, links: 1, inputs: 1 },
    });
    expect(JSON.stringify(evidence)).not.toContain('super-secret');
    expect(JSON.stringify(evidence)).not.toContain('private body content');
    expect(JSON.stringify(evidence)).not.toContain('token=secret');
    expect(evidence.regions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'main', headings: ['Mission Tasks'] }),
      expect.objectContaining({ kind: 'form', controls: ['Access code', 'Sign in'] }),
    ]));
  });

  it('tracks route changes and clears stale page structure', () => {
    const previous = buildBrowserEvidence('<title>Login</title><h1>Sign in</h1>', {
      url: 'https://example.test/login',
    });
    const evidence = buildBrowserEvidence(null, {
      url: 'https://example.test/dashboard',
      previous,
    });

    expect(evidence).toEqual({
      url: 'https://example.test/dashboard',
      previousUrl: 'https://example.test/login',
      routeChanged: true,
    });
  });
});
