import { describe, expect, it, vi } from 'vitest';
import { __test__, getEmailCode, resolveEmailInboxNickname } from '../../tools/emailCode.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe('getEmailCode', () => {
  it('preserves proxy paths in API base URLs', () => {
    expect(__test__.endpointUrl('http://127.0.0.1:3101/proxy/3101', '/api/email-inboxes'))
      .toBe('http://127.0.0.1:3101/proxy/3101/api/email-inboxes');
  });
  it('resolves the configured inbox nickname', () => {
    expect(resolveEmailInboxNickname({}, { emailInboxName: 'github staging' })).toBe('github staging');
  });

  it('auto-selects one inbox and returns sanitized message candidates', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { entries: [{ nickname: 'github staging', active: true }] }))
      .mockResolvedValueOnce(response(200, { nickname: 'github staging', sanitizedText: 'Your code is 482193', codeCandidates: ['482193'], senderDomain: 'github.com' }));
    const result = await getEmailCode({ timeoutSeconds: 0, siteHost: 'github.com' }, { config: { sessionToken: 'session' }, apiBase: 'https://api.example.test', fetchImpl });
    expect(result).toMatchObject({ ok: true, nickname: 'github staging', codeCandidates: ['482193'] });
  });

  it('returns available nicknames instead of guessing among several inboxes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { entries: [{ nickname: 'one' }, { nickname: 'two' }] }));
    const result = await getEmailCode({ timeoutSeconds: 0 }, { config: { sessionToken: 'session' }, apiBase: 'https://api.example.test', fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'missing_inbox', availableNicknames: ['one', 'two'] });
  });
});
