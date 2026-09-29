import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmailLink, openEmailLink, resolveAllowedEmailLinkHosts } from '../../tools/emailLink.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

afterEach(() => {
  delete process.env.TESTRONAUT_EMAIL_LINK_HOSTS;
});

describe('email link tools', () => {
  it('resolves allowed hosts only from trusted config or environment', () => {
    expect(resolveAllowedEmailLinkHosts({ emailLinks: { allowedHosts: [' Accounts.Example.test ', 'bad/path'] } }))
      .toEqual(['accounts.example.test']);
    process.env.TESTRONAUT_EMAIL_LINK_HOSTS = 'login.example.test, accounts.example.test';
    expect(resolveAllowedEmailLinkHosts({ emailLinks: { allowedHosts: ['ignored.test'] } }))
      .toEqual(['login.example.test', 'accounts.example.test']);
  });

  it('returns opaque link metadata without returning a URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, {
      nickname: 'staging',
      subject: 'Invitation',
      links: [{ linkId: 'opaque-id', host: 'accounts.example.test', label: 'Accept invitation' }],
    }));
    const result = await getEmailLink(
      { nickname: 'staging', timeoutSeconds: 0 },
      { config: { sessionToken: 'session' }, apiBase: 'https://api.example.test', fetchImpl }
    );
    expect(result).toMatchObject({ ok: true, links: [{ linkId: 'opaque-id', host: 'accounts.example.test' }] });
    expect(JSON.stringify(result)).not.toContain('https://accounts.example.test/invite');
  });

  it('resolves and navigates internally without returning the bearer URL', async () => {
    const secretUrl = 'https://accounts.example.test/invite/super-secret-token';
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { url: secretUrl, host: 'accounts.example.test' }));
    const browser = { navigateEmailLink: vi.fn().mockResolvedValue({ host: 'accounts.example.test' }) };
    const result = await openEmailLink(
      { linkId: 'opaque-id' },
      {
        config: { sessionToken: 'session', emailLinks: { allowedHosts: ['accounts.example.test'] } },
        apiBase: 'https://api.example.test',
        fetchImpl,
        browser,
      }
    );
    expect(browser.navigateEmailLink).toHaveBeenCalledWith({ url: secretUrl, allowedHosts: ['accounts.example.test'] });
    expect(result).toEqual({ ok: true, host: 'accounts.example.test', opened: true });
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('refuses to resolve a link without a trusted host allowlist', async () => {
    const fetchImpl = vi.fn();
    const result = await openEmailLink(
      { linkId: 'opaque-id' },
      { config: { sessionToken: 'session' }, apiBase: 'https://api.example.test', fetchImpl, browser: {} }
    );
    expect(result).toMatchObject({ ok: false, code: 'missing_allowed_hosts' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
