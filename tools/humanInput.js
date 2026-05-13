import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { stdin as input, stdout as output } from 'node:process';
import { maskPreview } from '../core/redaction.js';

const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_CODE_LENGTH = 64;
const MIN_CODE_LENGTH = 1;
const MAX_CODE_LENGTH = 64;
const CODE_RE = /^[A-Za-z0-9_-]+$/;

class HiddenInputOutput extends Writable {
  constructor(realOutput) {
    super();
    this.realOutput = realOutput;
    this.hidden = false;
  }

  _write(chunk, encoding, callback) {
    if (!this.hidden) {
      this.realOutput.write(chunk, encoding);
    }
    callback();
  }
}

function clampNumber(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: fallback, clamped: false };
  const value = Math.min(max, Math.max(min, Math.trunc(n)));
  return { value, clamped: value !== n };
}

export function normalizeHumanInputOptions(opts = {}) {
  const timeout = clampNumber(
    opts.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS
  );
  const maxLength = clampNumber(
    opts.maxLength,
    DEFAULT_MAX_CODE_LENGTH,
    MIN_CODE_LENGTH,
    MAX_CODE_LENGTH
  );

  return {
    enabled: opts.enabled !== false,
    timeoutSeconds: timeout.value,
    timeoutClamped: timeout.clamped,
    maxLength: maxLength.value,
    maxLengthClamped: maxLength.clamped,
  };
}

export function sanitizeHumanCodeInput(raw, { maxLength = DEFAULT_MAX_CODE_LENGTH } = {}) {
  const normalizedMax = clampNumber(maxLength, DEFAULT_MAX_CODE_LENGTH, MIN_CODE_LENGTH, MAX_CODE_LENGTH).value;
  const value = String(raw ?? '').trim().replace(/\s+/g, '');

  if (!value) {
    return { ok: false, reason: 'empty', value: '' };
  }
  if (value.length > normalizedMax) {
    return { ok: false, reason: 'too_long', value: '' };
  }
  if (!CODE_RE.test(value)) {
    return { ok: false, reason: 'invalid_characters', value: '' };
  }

  return { ok: true, value };
}

export function questionWithHiddenInput(prompt, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const maskedOutput = new HiddenInputOutput(output);
    const rl = createInterface({
      input,
      output: maskedOutput,
      terminal: Boolean(output.isTTY),
    });

    let settled = false;
    let timeout;

    function finish(err, answer) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      maskedOutput.hidden = false;
      output.write('\n');
      rl.close();
      if (err) reject(err);
      else resolve(answer);
    }

    if (timeoutMs) {
      timeout = setTimeout(() => {
        const err = new Error('Human input timed out.');
        err.name = 'AbortError';
        finish(err);
      }, timeoutMs);
    }

    output.write(prompt);
    maskedOutput.hidden = true;
    rl.question('', (answer) => finish(null, answer));
  });
}

export async function requestHumanInput(args = {}, options = {}) {
  const opts = normalizeHumanInputOptions({
    ...options,
    maxLength: args.maxLength ?? options.maxLength,
  });

  if (!opts.enabled) {
    throw new Error('Human input tool is disabled for this run.');
  }

  const codeType = String(args.codeType || 'verification_code')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40) || 'verification_code';
  const prompt = String(args.prompt || `Enter ${codeType.replace(/_/g, ' ')}:`).trim();
  const label = prompt.endsWith(':') ? prompt : `${prompt}:`;
  const timeoutMs = opts.timeoutSeconds * 1000;

  let answer;
  try {
    answer = await questionWithHiddenInput(`\n👤 ${label} `, { timeoutMs });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Human input timed out after ${opts.timeoutSeconds}s.`);
    }
    throw err;
  }

  const sanitized = sanitizeHumanCodeInput(answer, { maxLength: opts.maxLength });
  if (!sanitized.ok) {
    throw new Error(`Human input rejected: ${sanitized.reason}.`);
  }

  return {
    ok: true,
    humanInputProvided: true,
    codeType,
    value: sanitized.value,
    redactedValue: maskPreview(sanitized.value),
  };
}

export const __test__ = {
  DEFAULT_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_MAX_CODE_LENGTH,
  MAX_CODE_LENGTH,
  sanitizeHumanCodeInput,
  normalizeHumanInputOptions,
  questionWithHiddenInput,
};
