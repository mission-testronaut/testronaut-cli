import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getMfaCode,
  resolveMfaNickname,
  __test__,
} from '../../tools/mfaCode.js';

function response({ ok = true, status = 200, statusText = 'OK', body = {}, text, contentType = 'application/json' } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name) => name.toLowerCase() === 'content-type' ? contentType : '',
    },
    text: vi.fn().mockResolvedValue(text ?? JSON.stringify(body)),
  };
}

describe('tools/mfaCode', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...oldEnv };
    vi.clearAllMocks();
  });

  it('resolves MFA nickname from args, env, and config', () => {
    expect(resolveMfaNickname({ nickname: 'from-args' }, { mfaName: 'from-config' })).toBe('from-args');

    process.env.TESTRONAUT_MFA_NAME = 'from-env';
    expect(resolveMfaNickname({}, { mfaName: 'from-config' })).toBe('from-env');

    delete process.env.TESTRONAUT_MFA_NAME;
    expect(resolveMfaNickname({}, { mfa: { name: 'from-nested-config' } })).toBe('from-nested-config');
  });

  it('returns a graceful error when nickname is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      body: { nicknames: [] },
    }));

    const result = await getMfaCode(
      {},
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'missing_nickname',
      availableNicknames: [],
      mfaListStatus: 'available',
    });
  });

  it('returns a graceful error when sessionToken is missing', async () => {
    const result = await getMfaCode({ nickname: 'github' }, { config: {} });

    expect(result).toMatchObject({
      ok: false,
      code: 'missing_session_token',
      nickname: 'github',
    });
  });

  it('retrieves and normalizes an MFA code from the API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      body: {
        nickname: 'GitHub',
        mfaCode: {
          code: '123456',
          expiresAt: '2026-07-02T20:00:30.000Z',
          secondsRemaining: 20,
        },
      },
    }));

    const result = await getMfaCode(
      { nickname: 'GitHub', waitForFreshCode: false },
      {
        apiBase: 'https://api.example.test',
        config: { sessionToken: 'session-token' },
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/api/mfa?nickname=GitHub',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer session-token',
        }),
      })
    );
    expect(result).toEqual({
      ok: true,
      codeType: 'totp',
      nickname: 'GitHub',
      value: '123456',
      redactedValue: '•••••• (6)',
      mfaCode: {
        code: '123456',
        expiresAt: '2026-07-02T20:00:30.000Z',
        secondsRemaining: 20,
      },
    });
  });

  it('lists MFA nicknames and auto-selects when exactly one exists', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({
        body: { nicknames: ['GitHub Prod'] },
      }))
      .mockResolvedValueOnce(response({
        body: {
          nickname: 'GitHub Prod',
          mfaCode: { code: '123456', secondsRemaining: 20 },
        },
      }));

    const result = await getMfaCode(
      { waitForFreshCode: false },
      { apiBase: 'https://api.example.test', config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/mfa/list',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/api/mfa?nickname=GitHub+Prod',
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toMatchObject({
      ok: true,
      nickname: 'GitHub Prod',
      value: '123456',
      resolvedFromList: true,
      availableNicknames: ['GitHub Prod'],
    });
  });

  it('returns available nicknames when no nickname is provided and multiple exist', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      body: { nicknames: ['GitHub Prod', 'AWS Root'] },
    }));

    const result = await getMfaCode(
      {},
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'missing_nickname',
      availableNicknames: ['GitHub Prod', 'AWS Root'],
      mfaListStatus: 'available',
    });
    expect(result.error).toContain('GitHub Prod, AWS Root');
  });

  it('maps paid-plan failures without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      body: { error: 'MFA code generation requires an active paid subscription' },
    }));

    const result = await getMfaCode(
      { nickname: 'github' },
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(result).toMatchObject({
      ok: false,
      status: 402,
      code: 'premium_required',
      error:
        'This Testronaut account is not eligible for automated MFA because it does not have an active paid subscription.',
      apiError: 'MFA code generation requires an active paid subscription',
      nickname: 'github',
    });
  });

  it('accepts alternate API response code shapes', () => {
    expect(__test__.normalizeApiCode({ code: '654321' })).toMatchObject({ value: '654321' });
    expect(__test__.normalizeApiCode({ totp: { value: '123456' } })).toMatchObject({ value: '123456' });
    expect(__test__.normalizeApiCode({ otp: { token: '234567' } })).toMatchObject({ value: '234567' });
    expect(__test__.normalizeApiCode({ mfaCode: { mfaCode: '345678' } })).toMatchObject({ value: '345678' });
    expect(__test__.normalizeApiCode({ mfaCode: { code: 12345 } })).toMatchObject({ value: '012345' });
  });

  it('returns safe diagnostics for unrecognized successful responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      body: { nickname: 'GitHub', message: 'ok but no code here' },
    }));

    const result = await getMfaCode(
      { nickname: 'github' },
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(result).toMatchObject({
      ok: false,
      status: 200,
      code: 'invalid_response',
      contentType: 'application/json',
      responseKeys: ['nickname', 'message'],
      nickname: 'github',
    });
    expect(result.error).toContain('Response keys: nickname, message');
  });

  it('maps missing MFA entries without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: { error: 'MFA entry not found' },
    }));

    const result = await getMfaCode(
      { nickname: 'github' },
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: 'not_found',
      nickname: 'github',
    });
  });

  it('reports a clear error when the MFA code endpoint returns an app HTML shell', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({
        contentType: 'text/html; charset=utf-8',
        text: '<!DOCTYPE html><html><head></head><body>App shell</body></html>',
      }))
      .mockResolvedValueOnce(response({
        contentType: 'text/html; charset=utf-8',
        text: '<!DOCTYPE html><html><head></head><body>App shell</body></html>',
      }));

    const result = await getMfaCode(
      { nickname: 'github' },
      { apiBase: 'https://staging.api.example.test', config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://staging.api.example.test/api/mfa?nickname=github',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(result).toMatchObject({
      ok: false,
      status: 200,
      code: 'non_json_response',
      contentType: 'text/html; charset=utf-8',
      nickname: 'github',
      availableNicknames: [],
      mfaListStatus: {
        code: 'non_json_response',
        status: 200,
      },
    });
    expect(result.error).toMatch(/non-JSON response/i);
    expect(result.apiError).toContain('https://staging.api.example.test/api/mfa');
  });

  it('uses the list endpoint to recover from fuzzy nickname mismatches', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: { error: 'MFA entry not found' },
      }))
      .mockResolvedValueOnce(response({
        body: { nicknames: ['rudy-poo'] },
      }))
      .mockResolvedValueOnce(response({
        body: {
          nickname: 'rudy-poo',
          mfaCode: { code: '123456', secondsRemaining: 20 },
        },
      }));

    const result = await getMfaCode(
      { nickname: 'rudy poo', waitForFreshCode: false },
      { apiBase: 'https://api.example.test', config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/mfa?nickname=rudy+poo',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/api/mfa/list',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://api.example.test/api/mfa?nickname=rudy-poo',
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toMatchObject({
      ok: true,
      nickname: 'rudy-poo',
      value: '123456',
      requestedNickname: 'rudy poo',
      resolvedFromList: true,
      availableNicknames: ['rudy-poo'],
    });
  });

  it('adds available nicknames when a requested nickname is not found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: { error: 'MFA entry not found' },
      }))
      .mockResolvedValueOnce(response({
        body: { entries: [{ nickname: 'GitHub Prod' }, { nickname: 'AWS Root' }] },
      }));

    const result = await getMfaCode(
      { nickname: 'missing' },
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'not_found',
      availableNicknames: ['GitHub Prod', 'AWS Root'],
      mfaListStatus: 'available',
    });
  });

  it('uses the effective API base and Vercel bypass header from env', async () => {
    process.env.TESTRONAUT_API_BASE_EFFECTIVE = 'https://staging.api.example.test/';
    process.env.TESTRONAUT_VERCEL_BYPASS = 'bypass-secret';
    const fetchImpl = vi.fn().mockResolvedValue(response({
      body: { nickname: 'GitHub', mfaCode: { code: '123456', secondsRemaining: 20 } },
    }));

    await getMfaCode(
      { nickname: 'GitHub', waitForFreshCode: false },
      { config: { sessionToken: 'session-token' }, fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://staging.api.example.test/api/mfa?nickname=GitHub',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer session-token',
          'x-vercel-protection-bypass': 'bypass-secret',
        }),
      })
    );
  });

  it('writes sanitized MFA API request and response debug logs when debug is enabled', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-mfa-debug-'));
    process.env.TESTRONAUT_API_DEBUG = '1';
    process.env.TESTRONAUT_VERCEL_BYPASS = 'bypass-secret';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({
        body: { nickname: 'GitHub', mfaCode: { code: '123456', secondsRemaining: 20 } },
      }))
      .mockResolvedValueOnce(response({
        body: { nicknames: ['GitHub', 'AWS Root'] },
      }));

    await getMfaCode(
      { nickname: 'GitHub', waitForFreshCode: false },
      {
        cwd,
        apiBase: 'https://api.example.test',
        config: { sessionToken: 'session-token' },
        fetchImpl,
      }
    );

    await getMfaCode(
      {},
      {
        cwd,
        apiBase: 'https://api.example.test',
        config: { sessionToken: 'session-token' },
        fetchImpl,
      }
    );

    const logPath = path.join(cwd, 'missions/mission_reports/api-debug.log');
    const log = fs.readFileSync(logPath, 'utf8');

    expect(log).toContain('"endpoint": "get_code"');
    expect(log).toContain('https://api.example.test/api/mfa?nickname=GitHub');
    expect(log).toContain('"endpoint": "list"');
    expect(log).toContain('https://api.example.test/api/mfa/list');
    expect(log).toContain('"statusCode": 200');
    expect(log).toContain('"responseShape": "recognized_code"');
    expect(log).toContain('"availableNicknames"');
    expect(log).toContain('AWS Root');
    expect(log).toContain('<redacted>');
    expect(log).not.toContain('session-token');
    expect(log).not.toContain('bypass-secret');
    expect(log).not.toContain('123456');
  });

  it('classifies feature-disabled 404s separately', () => {
    expect(__test__.errorCodeForStatus(404, 'MFA endpoints are not enabled')).toBe('feature_disabled');
  });

  it('formats friendly account access errors', () => {
    expect(__test__.friendlyMfaError('premium_required')).toMatch(/not eligible/i);
  });

  it('matches listed MFA nicknames case-insensitively and punctuation-insensitively', () => {
    expect(__test__.findListedNicknameMatch('RUDY POO', ['rudy-poo'])).toBe('rudy-poo');
    expect(__test__.findListedNicknameMatch('github prod', ['GitHub Prod'])).toBe('GitHub Prod');
  });
});
