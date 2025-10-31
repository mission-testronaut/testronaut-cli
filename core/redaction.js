/**
 * redaction.js
 * -------------
 * Purpose:
 *   Centralized redaction utilities for Testronaut logs and plans.
 *   - Single source of truth for sensitive keywords
 *   - Masks tool args when targeting sensitive fields (e.g., #access, password inputs)
 *   - Masks free-form instructions that reveal credentials
 *
 * Design goals:
 *   - No side effects (pure functions)
 *   - Easy to extend by editing one keyword list
 *   - Unit testable via Vitest
 *
 * Related tests:
 *   See `tests/core/redaction.test.js`
 *
 * Used by:
 *   - CLI log/plan renderers
 *   - Tool call serializers (type/fill)
 *
 * Example usage:
 *   const safeArgs = redactArgs('fill', { selector: '#access', text: 'P@ssw0rd' });
 *   const safePlan = redactPasswordInText(`Type "P@ssw0rd" into #access`);
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sensitive Keywords (Single Source of Truth)
// Add/remove terms here and every consumer updates automatically.
// Hyphenated forms are expanded to also match `_` and spaces (api-key/api_key/api key).
// ─────────────────────────────────────────────────────────────────────────────

export const SENSITIVE_KEYWORDS = [
  'pass',
  'password',
  'pwd',
  'passwd',
  'access',
  'secret',
  'token',
  'api-key',
  'apikey',
  'bearer',
  'auth',
  'pin',
  'otp',
];

/**
 * Builds a single RegExp that treats hyphens as `[-_\s]?` to catch variants.
 * @returns {RegExp}
 */
function buildSensitiveRegex() {
  // Expand hyphen variants: "api-key" -> "api[-_\s]?key"
  const parts = SENSITIVE_KEYWORDS.map(k => k.replace(/-/g, '[-_\\s]?'));
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

const SENSITIVE_RE = buildSensitiveRegex();

// ─────────────────────────────────────────────────────────────────────────────
// Core helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe clone: prefer structuredClone, fallback to JSON.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function clone(obj) {
  try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj ?? {})); }
}

/**
 * Returns a masked preview. If showLength is true, includes length for debugging.
 * @param {unknown} val
 * @param {boolean} [showLength=true]
 * @returns {string}
 */
export function maskPreview(val, showLength = true) {
  const s = String(val ?? '');
  if (!s) return '••••••';
  return showLength ? `•••••• (${s.length})` : '••••••';
}

/**
 * True if the provided string contains sensitive hints (password, token, access, etc.).
 * @param {string} [str='']
 * @returns {boolean}
 */
function hasSensitiveHint(str = '') {
  return SENSITIVE_RE.test(String(str || ''));
}

/**
 * True if an HTML input type itself is sensitive.
 * @param {string} [t='']
 * @returns {boolean}
 */
function isSensitiveInputType(t = '') {
  return String(t || '').toLowerCase() === 'password';
}

/**
 * Returns true if a tool call (type/fill) looks like it targets a sensitive field.
 * We check selector/label/placeholder/name/role/testId OR inputType=password.
 *
 * @param {'type'|'fill'|string} fnName
 * @param {object} [args={}]
 * @returns {boolean}
 */
function isSensitiveCall(fnName, args = {}) {
  if (!(fnName === 'type' || fnName === 'fill')) return false;
  const { selector, label, placeholder, name, inputType, role, testId } = args || {};
  return (
    hasSensitiveHint(selector) ||
    hasSensitiveHint(label) ||
    hasSensitiveHint(placeholder) ||
    hasSensitiveHint(name) ||
    isSensitiveInputType(inputType) ||
    hasSensitiveHint(role) ||
    hasSensitiveHint(testId)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redact ONLY secret-like values in tool args (shallow).
 * - Masks any property whose *key* name looks sensitive (e.g., apiKey, token)
 * - If the call targets a sensitive field, masks common value props (text/value/input/keys)
 *
 * @param {'type'|'fill'|string} fnName
 * @param {Record<string, unknown>} [args={}]
 * @param {{ showLength?: boolean }} [opts]
 * @returns {Record<string, unknown>}
 */
export function redactArgs(fnName, args = {}, { showLength = true } = {}) {
  const out = clone(args);

  // Mask direct props with sensitive-looking keys
  for (const k of Object.keys(out || {})) {
    if (hasSensitiveHint(k)) {
      out[k] = maskPreview(out[k], showLength);
    }
  }

  // Mask value-like props when the call targets a sensitive field
  if (isSensitiveCall(fnName, args)) {
    for (const key of ['text', 'value', 'input', 'keys']) {
      if (key in out) out[key] = maskPreview(out[key], showLength);
    }
  }

  return out;
}

/**
 * Redact sensitive literals in freeform mission text.
 *
 * Cases:
 * 1) Sensitive-word ... "VALUE"
 *    e.g., `password is "hunter2"`
 *
 * 2) Sensitive-word ... (with|as|to|=) VALUE
 *    e.g., `token=abcd1234`, `auth with xyz`
 *
 * 3) "VALUE" ... into/in/on/to TARGET  (TARGET contains a sensitive hint)
 *    e.g., `Type "Imp0st3r123!" into #access`
 *
 * @param {string} [text='']
 * @param {{ showLength?: boolean }} [opts]
 * @returns {string}
 */
export function redactPasswordInText(text = '', { showLength = true } = {}) {
  let s = String(text ?? '');

  // Build a reusable source pattern for SENSITIVE_KEYWORDS with hyphen expansion
  const kwParts = SENSITIVE_KEYWORDS.map(k => k.replace(/-/g, '[-_\\s]?'));
  const kwGroup = `(${kwParts.join('|')})`;

  // Case 1: keyword ... "VALUE"
  s = s.replace(
    new RegExp(`(\\b${kwGroup}\\b[^"'\\\\\\n]{0,80}["'])([^"']+)(["'])`, 'gi'),
    (_m, pre, _kw, secret, post) => pre + maskPreview(secret, showLength) + post
  );

  // Case 2: keyword ... (with|as|to|=) VALUE
  s = s.replace(
    new RegExp(`(\\b${kwGroup}\\b[^.\\n]{0,80}?\\b(with|as|to|=)\\s*)([^\\s"'\\\`]+)`, 'gi'),
    (_m, pre, _kw1, _kw2, secret) => pre + maskPreview(secret, showLength)
  );

  // Case 3: "VALUE" ... into/in/on/to TARGET (TARGET looks sensitive)
  s = s.replace(
    /(["'`])([^"'`]+)\1\s+(?:into|in|on|to)\s+([^\s,.;:]+)/gi,
    (_m, q, val, target) => {
      if (hasSensitiveHint(target)) return q + maskPreview(val, showLength) + q + ' into ' + target;
      return _m;
    }
  );

  return s;
}
