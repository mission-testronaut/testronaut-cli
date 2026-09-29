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

function resolveSessionToken(cfg = {}) {
  return clean(process.env.TESTRONAUT_SESSION_TOKEN) || clean(cfg.sessionToken);
}

export function resolveAllowedEmailLinkHosts(cfg = {}) {
  const envHosts = clean(process.env.TESTRONAUT_EMAIL_LINK_HOSTS);
  const configured = envHosts
    ? envHosts.split(',')
    : Array.isArray(cfg.emailLinks?.allowedHosts) ? cfg.emailLinks.allowedHosts : [];
  return [...new Set(configured
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
    .filter(value => /^[a-z0-9.-]+$/.test(value)))];
}

function headers(sessionToken) {
  const bypass = clean(process.env.VERCEL_AUTOMATION_BYPASS_SECRET) || clean(process.env.TESTRONAUT_VERCEL_BYPASS);
  return { Accept: 'application/json', Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) };
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
  if (status === 403 && lower.includes('host')) return 'host_not_allowed';
  if (status === 429) return 'rate_limited';
  if (status === 404 && lower.includes('not enabled')) return 'feature_disabled';
  if (status === 404 && lower.includes('inbox')) return 'inbox_not_found';
  if (status === 404 && lower.includes('link')) return 'no_recent_link';
  return 'api_error';
}

export async function getEmailLink(args = {}, options = {}) {
  const cfg = options.config ?? await loadConfig(options.cwd || process.cwd());
  const sessionToken = resolveSessionToken(cfg);
  if (!sessionToken) return { ok: false, code: 'missing_session_token', error: 'No sessionToken found. Run `testronaut login` or add sessionToken to testronaut-config.json.' };
  const apiBase = resolveApiBase(options);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutSeconds = Number.isFinite(Number(args.timeoutSeconds)) ? Math.min(60, Math.max(0, Number(args.timeoutSeconds))) : 45;
  const lookbackSeconds = Math.min(3_600, Math.max(10, Number(args.lookbackSeconds) || 600));
  const lookupId = clean(args.lookupId) || crypto.randomUUID();
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last;
  do {
    const response = await fetchImpl(endpointUrl(apiBase, 'api/email-links/lookup'), {
      method: 'POST',
      headers: headers(sessionToken),
      body: JSON.stringify({ nickname: clean(args.nickname), siteHost: clean(args.siteHost), lookbackSeconds, lookupId }),
    });
    const { data, text } = await parseResponse(response);
    if (response.ok && Array.isArray(data?.links) && data.links.length) {
      return {
        ok: true,
        nickname: data.nickname,
        sender: data.sender,
        senderDomain: data.senderDomain,
        subject: data.subject,
        receivedAt: data.receivedAt,
        links: data.links.map(link => ({ linkId: link.linkId, host: link.host, label: link.label })),
        match: data.match,
      };
    }
    const code = errorCode(response.status, data?.error || text);
    last = { ok: false, status: response.status, code, error: data?.error || text || 'Unable to retrieve an email link', nickname: clean(args.nickname) || null };
    if (code !== 'no_recent_link' || Date.now() >= deadline) break;
    await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return last?.code === 'no_recent_link' && timeoutSeconds > 0
    ? { ...last, code: 'delivery_timeout', error: `No matching email link arrived within ${timeoutSeconds} seconds.` }
    : last;
}

export async function openEmailLink(args = {}, options = {}) {
  const cfg = options.config ?? await loadConfig(options.cwd || process.cwd());
  const sessionToken = resolveSessionToken(cfg);
  if (!sessionToken) return { ok: false, code: 'missing_session_token', error: 'No sessionToken found. Run `testronaut login` or add sessionToken to testronaut-config.json.' };
  const allowedHosts = resolveAllowedEmailLinkHosts(cfg);
  if (!allowedHosts.length) {
    return { ok: false, code: 'missing_allowed_hosts', error: 'No trusted email-link hosts are configured. Set emailLinks.allowedHosts or TESTRONAUT_EMAIL_LINK_HOSTS.' };
  }
  const linkId = clean(args.linkId);
  if (!linkId) return { ok: false, code: 'missing_link_id', error: 'linkId is required.' };

  const apiBase = resolveApiBase(options);
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(endpointUrl(apiBase, 'api/email-links/resolve'), {
    method: 'POST',
    headers: headers(sessionToken),
    body: JSON.stringify({ linkId, allowedHosts }),
  });
  const { data, text } = await parseResponse(response);
  if (!response.ok || !clean(data?.url)) {
    return { ok: false, status: response.status, code: errorCode(response.status, data?.error || text), error: data?.error || text || 'Unable to resolve email link' };
  }
  if (!options.browser?.navigateEmailLink) throw new Error('Browser email-link navigation is unavailable.');
  const navigation = await options.browser.navigateEmailLink({ url: data.url, allowedHosts });
  return { ok: true, host: navigation.host, opened: true };
}

export const __test__ = { resolveApiBase, endpointUrl, errorCode };
