import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../core/config.js';
import { maskPreview } from '../core/redaction.js';

export const DEFAULT_API_BASE = 'http://api.testronaut.app';
export const DEV_API_BASE = 'https://staging.api.testronaut.app';

const MIN_REMAINING_SECONDS = 5;
const MAX_REMAINING_SECONDS = 25;
const API_DEBUG_LOG_RELATIVE_PATH = 'missions/mission_reports/api-debug.log';
const REDACTED = '<redacted>';

const SENSITIVE_LOG_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'api-key',
  'bearer',
  'code',
  'mfacode',
  'mfa_code',
  'mfa-code',
  'otp',
  'password',
  'secret',
  'sessiontoken',
  'session_token',
  'session-token',
  'token',
  'totp',
  'value',
  'x-vercel-protection-bypass',
]);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseDebugBool(value) {
  const normalized = cleanString(value).toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on';
}

function isApiDebugEnabled() {
  return parseDebugBool(process.env.TESTRONAUT_API_DEBUG) ||
    parseDebugBool(process.env.TESTRONAUT_DEBUG);
}

function apiDebugLogPath(cwd = process.cwd()) {
  return path.resolve(cwd, API_DEBUG_LOG_RELATIVE_PATH);
}

function normalizeLogKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function isSensitiveLogKey(key) {
  return SENSITIVE_LOG_KEYS.has(normalizeLogKey(key));
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers || {})) {
    redacted[key] = isSensitiveLogKey(key) ? REDACTED : value;
  }
  return redacted;
}

function redactText(text = '') {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/("(?:authorization|apiKey|api_key|code|mfaCode|otp|secret|sessionToken|token|totp|value)"\s*:\s*)"[^"]*"/gi, `$1"${REDACTED}"`);
}

function redactLogValue(value, parentKey = '') {
  if (isSensitiveLogKey(parentKey)) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactLogValue(item));
  }
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, childValue] of Object.entries(value)) {
      redacted[key] = redactLogValue(childValue, key);
    }
    return redacted;
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  return value;
}

function safeBodyPreview(text, data, limit = 2500) {
  const source = data && typeof data === 'object'
    ? JSON.stringify(redactLogValue(data), null, 2)
    : redactText(text || '');

  if (source.length <= limit) return source;
  return `${source.slice(0, limit)}... <truncated ${source.length - limit} chars>`;
}

function responseKeysForLog(data) {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data).slice(0, 20)
    : [];
}

function writeApiDebugLog(entry, { cwd = process.cwd() } = {}) {
  if (!isApiDebugEnabled()) return;

  const filePath = apiDebugLogPath(cwd);
  const safeEntry = redactLogValue({
    timestamp: new Date().toISOString(),
    ...entry,
  });

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(safeEntry, null, 2)}\n`, 'utf8');
  } catch {
    // Debug logging should never break a mission run.
  }
}

function cleanCodeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value)).padStart(6, '0');
  }
  return cleanString(value);
}

function normalizeNicknameForMatch(value) {
  return cleanString(value).toLowerCase();
}

function compactNicknameForMatch(value) {
  return normalizeNicknameForMatch(value).replace(/[^a-z0-9]/g, '');
}

function clampSeconds(raw, fallback = MIN_REMAINING_SECONDS) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_REMAINING_SECONDS, Math.max(0, Math.trunc(n)));
}

function bearerHeaders(sessionToken, extraHeaders = {}) {
  const bypass =
    cleanString(process.env.VERCEL_AUTOMATION_BYPASS_SECRET) ||
    cleanString(process.env.TESTRONAUT_VERCEL_BYPASS);

  return {
    Accept: 'application/json',
    ...extraHeaders,
    Authorization: `Bearer ${sessionToken}`,
    ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
  };
}

function resolveApiBase(options = {}) {
  return (
    cleanString(options.apiBase) ||
    cleanString(process.env.TESTRONAUT_API_BASE_EFFECTIVE) ||
    cleanString(process.env.TESTRONAUT_API_BASE) ||
    DEFAULT_API_BASE
  ).replace(/\/+$/, '');
}

export function resolveMfaNickname(args = {}, cfg = {}) {
  return (
    cleanString(args.nickname) ||
    cleanString(args.mfaName) ||
    cleanString(args.name) ||
    cleanString(process.env.TESTRONAUT_MFA_NAME) ||
    cleanString(cfg.mfaName) ||
    cleanString(cfg.mfa?.name) ||
    cleanString(cfg.mfa?.nickname)
  );
}

function resolveSessionToken(args = {}, cfg = {}) {
  return (
    cleanString(args.sessionToken) ||
    cleanString(process.env.TESTRONAUT_SESSION_TOKEN) ||
    cleanString(cfg.sessionToken)
  );
}

function errorCodeForStatus(status, error = '') {
  const normalized = String(error).toLowerCase();
  if (status === 401) return 'invalid_session';
  if (status === 402) return 'premium_required';
  if (status === 404 && normalized.includes('not enabled')) return 'feature_disabled';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'api_error';
}

function friendlyMfaError(code, apiError = '') {
  if (code === 'premium_required') {
    return 'This Testronaut account is not eligible for automated MFA because it does not have an active paid subscription.';
  }
  if (code === 'invalid_session') {
    return 'The saved Testronaut session token is invalid or expired. Run `testronaut login` again.';
  }
  if (code === 'feature_disabled') {
    return 'Automated MFA is not enabled for this Testronaut environment.';
  }
  if (code === 'not_found') {
    return 'No stored MFA entry was found for that nickname.';
  }
  if (code === 'rate_limited') {
    return 'The MFA API is rate limited. Try again shortly.';
  }
  if (code === 'non_json_response') {
    return 'The MFA API returned a non-JSON response. This usually means the CLI is pointed at the app host or a fallback page instead of the API host.';
  }
  return apiError || 'Unable to retrieve MFA code.';
}

function normalizeApiCode(data) {
  const codeObject =
    data?.mfaCode && typeof data.mfaCode === 'object'
      ? data.mfaCode
      : data?.code && typeof data.code === 'object'
        ? data.code
        : data?.totp && typeof data.totp === 'object'
          ? data.totp
          : data?.otp && typeof data.otp === 'object'
            ? data.otp
            : {
                code:
                  data?.mfaCode ??
                  data?.code ??
                  data?.totp ??
                  data?.otp ??
                  data?.value ??
                  data?.token,
              };

  const value = cleanCodeValue(
    codeObject.code ??
      codeObject.value ??
      codeObject.mfaCode ??
      codeObject.totp ??
      codeObject.otp ??
      codeObject.token
  );
  if (!value) return null;

  return {
    value,
    expiresAt: codeObject.expiresAt,
    secondsRemaining: Number(codeObject.secondsRemaining),
  };
}

function normalizeMfaNicknames(data) {
  const fromNicknames = Array.isArray(data?.nicknames)
    ? data.nicknames
    : [];
  const fromEntries = Array.isArray(data?.entries)
    ? data.entries.map(entry => entry?.nickname)
    : [];
  const seen = new Set();
  const nicknames = [];

  for (const raw of [...fromNicknames, ...fromEntries]) {
    const nickname = cleanString(raw);
    const key = normalizeNicknameForMatch(nickname);
    if (!nickname || seen.has(key)) continue;
    seen.add(key);
    nicknames.push(nickname);
  }

  return nicknames;
}

function findListedNicknameMatch(requestedNickname, availableNicknames = []) {
  const requested = normalizeNicknameForMatch(requestedNickname);
  const exact = availableNicknames.find(
    nickname => normalizeNicknameForMatch(nickname) === requested
  );
  if (exact) return exact;

  const compactRequested = compactNicknameForMatch(requestedNickname);
  const compactMatches = availableNicknames.filter(
    nickname => compactNicknameForMatch(nickname) === compactRequested
  );
  return compactMatches.length === 1 ? compactMatches[0] : null;
}

async function fetchMfaList({ apiBase, sessionToken, fetchImpl = fetch, cwd = process.cwd() }) {
  const url = new URL('/api/mfa/list', `${apiBase}/`);
  const headers = bearerHeaders(sessionToken);
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers,
  });

  const text = await response.text();
  const contentType = response.headers?.get?.('content-type') || response.headers?.get?.('Content-Type') || '';
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const availableNicknames = response.ok ? normalizeMfaNicknames(data) : [];

  writeApiDebugLog({
    type: 'mfa-api',
    endpoint: 'list',
    request: {
      method: 'GET',
      url: url.toString(),
      headers: redactHeaders(headers),
    },
    response: {
      ok: response.ok,
      statusCode: response.status,
      statusText: response.statusText,
      contentType,
      bodyLength: text.length,
      responseKeys: responseKeysForLog(data),
      bodyPreview: safeBodyPreview(text, data),
    },
    parsed: {
      availableNicknames,
      responseShape: data && typeof data === 'object' ? 'json' : 'non_json',
    },
  }, { cwd });

  if (response.ok && !data) {
    const apiError = `Expected JSON from ${url.origin}/api/mfa/list but received ${contentType || 'unknown content type'}.`;
    return {
      ok: false,
      status: response.status,
      code: 'non_json_response',
      error: friendlyMfaError('non_json_response', apiError),
      apiError,
      contentType,
      availableNicknames: [],
    };
  }

  if (!response.ok) {
    const apiError = data?.error || text || response.statusText || 'Unable to list MFA entries';
    const code = errorCodeForStatus(response.status, apiError);
    return {
      ok: false,
      status: response.status,
      code,
      error: friendlyMfaError(code, apiError),
      apiError,
      availableNicknames: [],
    };
  }

  return {
    ok: true,
    availableNicknames,
  };
}

async function addAvailableNicknames(result, { apiBase, sessionToken, fetchImpl, cwd }) {
  const list = await fetchMfaList({ apiBase, sessionToken, fetchImpl, cwd });
  return {
    ...result,
    availableNicknames: list.ok ? list.availableNicknames : [],
    mfaListStatus: list.ok
      ? 'available'
      : {
          code: list.code,
          status: list.status,
          error: list.error,
        },
  };
}

async function fetchMfaCode({ apiBase, sessionToken, nickname, fetchImpl = fetch, cwd = process.cwd() }) {
  const url = new URL('/api/mfa', `${apiBase}/`);
  url.searchParams.set('nickname', nickname);
  const headers = bearerHeaders(sessionToken);

  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers,
  });

  const text = await response.text();
  const contentType = response.headers?.get?.('content-type') || response.headers?.get?.('Content-Type') || '';
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  writeApiDebugLog({
    type: 'mfa-api',
    endpoint: 'get_code',
    request: {
      method: 'GET',
      url: url.toString(),
      nickname,
      headers: redactHeaders(headers),
    },
    response: {
      ok: response.ok,
      statusCode: response.status,
      statusText: response.statusText,
      contentType,
      bodyLength: text.length,
      responseKeys: responseKeysForLog(data),
      bodyPreview: safeBodyPreview(text, data),
    },
    parsed: {
      responseShape: response.ok
        ? (data ? (normalizeApiCode(data) ? 'recognized_code' : 'unrecognized_code') : 'non_json')
        : 'error_response',
    },
  }, { cwd });

  if (response.ok && !data) {
    const apiError = `Expected JSON from ${url.origin}/api/mfa but received ${contentType || 'unknown content type'}.`;
    return {
      ok: false,
      status: response.status,
      code: 'non_json_response',
      error: friendlyMfaError('non_json_response', apiError),
      apiError,
      contentType,
      nickname,
    };
  }

  if (!response.ok) {
    const apiError = data?.error || text || response.statusText || 'Unable to retrieve MFA code';
    const code = errorCodeForStatus(response.status, apiError);
    return {
      ok: false,
      status: response.status,
      code,
      error: friendlyMfaError(code, apiError),
      apiError,
      nickname,
    };
  }

  const mfaCode = normalizeApiCode(data);
  if (!mfaCode) {
    const responseKeys = data && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data).slice(0, 12)
      : [];
    return {
      ok: false,
      status: response.status,
      code: 'invalid_response',
      error: responseKeys.length
        ? `MFA API response did not include a recognized code field. Response keys: ${responseKeys.join(', ')}.`
        : 'MFA API response did not include a recognized code field.',
      contentType,
      responseKeys,
      nickname,
    };
  }

  return {
    ok: true,
    codeType: 'totp',
    nickname: data?.nickname || nickname,
    value: mfaCode.value,
    redactedValue: maskPreview(mfaCode.value),
    mfaCode: {
      code: mfaCode.value,
      expiresAt: mfaCode.expiresAt,
      secondsRemaining: Number.isFinite(mfaCode.secondsRemaining)
        ? mfaCode.secondsRemaining
        : undefined,
    },
  };
}

/**
 * Retrieve a TOTP MFA code from the Testronaut API.
 *
 * @param {{ nickname?: string, mfaName?: string, name?: string, sessionToken?: string, minSecondsRemaining?: number, waitForFreshCode?: boolean }} args
 * @param {{ cwd?: string, apiBase?: string, fetchImpl?: Function, config?: object }} options
 * @returns {Promise<object>}
 */
export async function getMfaCode(args = {}, options = {}) {
  const cwd = options.cwd || process.cwd();
  const cfg = options.config ?? await loadConfig(cwd);
  const nickname = resolveMfaNickname(args, cfg);
  const sessionToken = resolveSessionToken(args, cfg);
  const apiBase = resolveApiBase(options);
  const minSecondsRemaining = clampSeconds(args.minSecondsRemaining);
  const waitForFreshCode = args.waitForFreshCode !== false;
  const fetchImpl = options.fetchImpl || fetch;

  async function fetchFreshCode(resolvedNickname, extra = {}) {
    let result = await fetchMfaCode({
      apiBase,
      sessionToken,
      nickname: resolvedNickname,
      fetchImpl,
      cwd,
    });

    const remaining = result?.mfaCode?.secondsRemaining;
    if (
      result.ok &&
      waitForFreshCode &&
      Number.isFinite(remaining) &&
      remaining > 0 &&
      remaining < minSecondsRemaining
    ) {
      await new Promise(resolve => setTimeout(resolve, (remaining + 1) * 1000));
      result = await fetchMfaCode({
        apiBase,
        sessionToken,
        nickname: resolvedNickname,
        fetchImpl,
        cwd,
      });
    }

    return {
      ...result,
      ...extra,
    };
  }

  if (!nickname) {
    if (sessionToken) {
      const list = await fetchMfaList({ apiBase, sessionToken, fetchImpl, cwd });
      if (list.ok && list.availableNicknames.length === 1) {
        return fetchFreshCode(list.availableNicknames[0], {
          resolvedFromList: true,
          requestedNickname: '',
          availableNicknames: list.availableNicknames,
        });
      }
      return {
        ok: false,
        code: 'missing_nickname',
        error: list.ok && list.availableNicknames.length
          ? `MFA nickname is required. Available MFA nicknames: ${list.availableNicknames.join(', ')}.`
          : 'MFA nickname is required. Pass nickname to the tool, set mfaName in testronaut-config.json, or run with -o mfa=<nickname>.',
        availableNicknames: list.ok ? list.availableNicknames : [],
        mfaListStatus: list.ok
          ? 'available'
          : {
              code: list.code,
              status: list.status,
              error: list.error,
            },
      };
    }

    return {
      ok: false,
      code: 'missing_nickname',
      error:
        'MFA nickname is required. Pass nickname to the tool, set mfaName in testronaut-config.json, or run with -o mfa=<nickname>.',
    };
  }

  if (!sessionToken) {
    return {
      ok: false,
      code: 'missing_session_token',
      error:
        'No sessionToken found. Run `testronaut login` or add sessionToken to testronaut-config.json.',
      nickname,
    };
  }

  try {
    const result = await fetchFreshCode(nickname);
    if (result.ok) {
      return result;
    }

    const resultWithList = await addAvailableNicknames(result, {
      apiBase,
      sessionToken,
      fetchImpl,
      cwd,
    });

    if (result.code === 'not_found' && resultWithList.availableNicknames?.length) {
      const matchedNickname = findListedNicknameMatch(
        nickname,
        resultWithList.availableNicknames
      );
      if (matchedNickname && matchedNickname !== nickname) {
        return fetchFreshCode(matchedNickname, {
          requestedNickname: nickname,
          resolvedFromList: true,
          availableNicknames: resultWithList.availableNicknames,
        });
      }
    }

    return resultWithList;
  } catch (error) {
    return {
      ok: false,
      code: 'network_error',
      error: error?.message || 'Unable to reach MFA API',
      nickname,
    };
  }
}

export const __test__ = {
  resolveApiBase,
  resolveMfaNickname,
  errorCodeForStatus,
  normalizeApiCode,
  normalizeMfaNicknames,
  findListedNicknameMatch,
  bearerHeaders,
  friendlyMfaError,
  apiDebugLogPath,
  isApiDebugEnabled,
  redactLogValue,
};
