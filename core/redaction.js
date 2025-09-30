// core/redaction.js

function clone(obj) {
  try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj ?? {})); }
}

export function maskPreview(val, showLength = true) {
  const s = String(val ?? '');
  if (!s) return '••••••';
  // Show length for debugging without leaking the value
  return showLength ? `•••••• (${s.length})` : '••••••';
}

function hasPasswordHint(str = '') {
  return /\b(pass(word)?|pwd|passwd)\b/i.test(String(str || ''));
}

function isPasswordCall(fnName, args = {}) {
  if (!(fnName === 'type' || fnName === 'fill')) return false;
  const { selector, label, placeholder, name, inputType, role, testId } = args;
  return (
    hasPasswordHint(selector) ||
    hasPasswordHint(label) ||
    hasPasswordHint(placeholder) ||
    hasPasswordHint(name) ||
    String(inputType || '').toLowerCase() === 'password' ||
    hasPasswordHint(role) ||
    hasPasswordHint(testId)
  );
}

/**
 * Redact ONLY password values in tool args:
 * - Applies to type/fill on password-looking fields
 * - Also masks any arg property explicitly named password/pwd/passwd (shallow)
 */
export function redactArgs(fnName, args = {}, { showLength = true } = {}) {
  const out = clone(args);

  // Mask direct props named password/pwd/passwd if present
  for (const k of Object.keys(out || {})) {
    if (hasPasswordHint(k)) {
      out[k] = maskPreview(out[k], showLength);
    }
  }

  // For typing into a password field, mask the value
  if (isPasswordCall(fnName, args)) {
    if ('text'  in out) out.text  = maskPreview(out.text, showLength);
    if ('value' in out) out.value = maskPreview(out.value, showLength);
    if ('input' in out) out.input = maskPreview(out.input, showLength);
    if ('keys'  in out) out.keys  = maskPreview(out.keys, showLength);
  }

  return out;
}

/**
 * Redact password literals in freeform mission text.
 * Heuristic: look for the word "password" then the next quoted string OR
 * a token after "with|as|to|=" within ~80 chars.
 */
export function redactPasswordInText(text = '', { showLength = true } = {}) {
  let s = String(text ?? '');

  // Case 1: password ... "VALUE"
  s = s.replace(
    /(\bpassword\b[^"'\\\n]{0,80}["'])([^"']+)(["'])/gi,
    (_m, pre, pwd, post) => pre + maskPreview(pwd, showLength) + post
  );

  // Case 2: password ... (with|as|to|=) VALUE
  s = s.replace(
    /(\bpassword\b[^.\n]{0,80}?\b(with|as|to|=)\s*)([^\s"'`]+)/gi,
    (_m, pre, _kw, pwd) => pre + maskPreview(pwd, showLength)
  );

  return s;
}
