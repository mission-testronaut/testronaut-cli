import crypto from 'crypto';
import fetch from 'node-fetch';
import { loadConfig } from '../core/config.js';
import { DEFAULT_API_BASE } from './mfaCode.js';

const clean = value => typeof value === 'string' ? value.trim() : '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function resolveApiBase(options = {}) {
  return (clean(options.apiBase) || clean(process.env.TESTRONAUT_API_BASE_EFFECTIVE) || clean(process.env.TESTRONAUT_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function endpointUrl(apiBase, endpoint) {
  return new URL(String(endpoint).replace(/^\/+/, ''), `${apiBase.replace(/\/+$/, '')}/`).toString();
}

export function resolveEmailInboxNickname(args = {}, cfg = {}) {
  return clean(args.nickname) || clean(args.inboxNickname) || clean(args.emailInbox) ||
    clean(process.env.TESTRONAUT_EMAIL_INBOX) || clean(cfg.emailInboxName) ||
    clean(cfg.emailInbox?.nickname) || clean(cfg.emailInbox);
}

function resolveSessionToken(args = {}, cfg = {}) {
  return clean(args.sessionToken) || clean(process.env.TESTRONAUT_SESSION_TOKEN) || clean(cfg.sessionToken);
}

function headers(sessionToken) {
  const bypass = clean(process.env.VERCEL_AUTOMATION_BYPASS_SECRET) || clean(process.env.TESTRONAUT_VERCEL_BYPASS);
  return { Accept: 'application/json', Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) };
}

function compact(value) { return clean(value).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function matchNickname(requested, available = []) {
  const matches = available.filter(value => compact(value) === compact(requested));
  return matches.length === 1 ? matches[0] : null;
}

async function parseResponse(response) {
  const text = await response.text();
  try { return { data: text ? JSON.parse(text) : null, text }; }
  catch { return { data: null, text }; }
}

function errorCode(status, message = '') {
  const lower = String(message).toLowerCase();
  if (status === 401) return 'invalid_session';
  if (status === 402) return 'premium_required';
  if (status === 429) return 'rate_limited';
  if (status === 404 && lower.includes('not enabled')) return 'feature_disabled';
  if (status === 404 && lower.includes('inbox')) return 'inbox_not_found';
  if (status === 404) return 'no_recent_email';
  if (status === 400 && lower.includes('nickname')) return 'missing_inbox';
  return 'api_error';
}

async function listInboxes(apiBase, sessionToken, fetchImpl) {
  const response = await fetchImpl(endpointUrl(apiBase, 'api/email-inboxes'), { headers: headers(sessionToken) });
  const { data, text } = await parseResponse(response);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!response.ok) return { ok: false, status: response.status, code: errorCode(response.status, data?.error || text), error: data?.error || text || 'Unable to list email inboxes', entries: [] };
  return { ok: true, entries, availableNicknames: entries.filter(entry => entry.active !== false).map(entry => entry.nickname) };
}

export async function getEmailCode(args = {}, options = {}) {
  const cfg = options.config ?? await loadConfig(options.cwd || process.cwd());
  const sessionToken = resolveSessionToken(args, cfg);
  const apiBase = resolveApiBase(options);
  const fetchImpl = options.fetchImpl || fetch;
  if (!sessionToken) return { ok: false, code: 'missing_session_token', error: 'No sessionToken found. Run `testronaut login` or add sessionToken to testronaut-config.json.' };

  const listed = await listInboxes(apiBase, sessionToken, fetchImpl);
  if (!listed.ok) return listed;
  let nickname = resolveEmailInboxNickname(args, cfg);
  const active = listed.entries.filter(entry => entry.active !== false);
  if (!nickname && active.length === 1) nickname = active[0].nickname;
  if (nickname) nickname = matchNickname(nickname, active.map(entry => entry.nickname)) || nickname;
  if (!nickname) return { ok: false, code: 'missing_inbox', error: active.length ? 'Email inbox nickname is required.' : 'No active email inbox is configured. Create one in the Testronaut app.', availableNicknames: active.map(entry => entry.nickname) };

  const requestedTimeout = Number(args.timeoutSeconds);
  const timeoutSeconds = Number.isFinite(requestedTimeout)
    ? Math.min(60, Math.max(0, requestedTimeout))
    : 45;
  const lookbackSeconds = Math.min(600, Math.max(10, Number(args.lookbackSeconds) || 120));
  const lookupId = clean(args.lookupId) || crypto.randomUUID();
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last;
  do {
    const response = await fetchImpl(endpointUrl(apiBase, 'api/email-codes/lookup'), {
      method: 'POST', headers: headers(sessionToken), body: JSON.stringify({ nickname, siteHost: clean(args.siteHost), lookbackSeconds, lookupId }),
    });
    const { data, text } = await parseResponse(response);
    if (response.ok && Array.isArray(data?.codeCandidates) && data.codeCandidates.length) {
      return { ok: true, codeType: 'email', nickname: data.nickname || nickname, sender: data.sender, senderDomain: data.senderDomain, subject: data.subject, receivedAt: data.receivedAt, sanitizedText: data.sanitizedText, codeCandidates: data.codeCandidates, match: data.match };
    }
    const code = errorCode(response.status, data?.error || text);
    last = { ok: false, status: response.status, code, error: data?.error || text || 'Unable to retrieve an email code', nickname, availableNicknames: listed.availableNicknames };
    if (code !== 'no_recent_email' || Date.now() >= deadline) break;
    await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return last?.code === 'no_recent_email' && timeoutSeconds > 0 ? { ...last, code: 'delivery_timeout', error: `No matching email code arrived within ${timeoutSeconds} seconds.` } : last;
}

export const __test__ = { resolveApiBase, endpointUrl, matchNickname, errorCode };
