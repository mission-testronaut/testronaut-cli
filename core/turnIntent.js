import { redactArgs } from './redaction.js';

export function truncateMiddle(str = '', max = 80) {
  if (!str || str.length <= max) return str;
  const half = Math.floor((max - 1) / 2);
  return `${str.slice(0, half)}…${str.slice(-half)}`;
}

function pickArg(args, keys) {
  for (const k of keys) {
    if (args?.[k] != null && String(args[k]).trim() !== '') return String(args[k]);
  }
  return null;
}

// core/turnIntent.js
const ICONS = {
  navigate: '🧭',
  click_text: '🖱️',
  click: '🖱️',
  type: '⌨️',
  fill: '⌨️',
  press: '⌨️',
  hover: '🪄',
  wait_for_selector: '⏳',
  wait: '⏳',
  screenshot: '📸',
  get_dom: '🧩',
  check_text: '🔍',
  scroll: '↕️',
  upload_file: '📤',
  download_file: '📥',
  expand_menu: '📂',
  set_viewport: '🖥️',
  default: '⚙️',
};

const EMOJI_ON_DEFAULT =
  process.env.TESTRONAUT_EMOJI === '1' || process.env.TESTRONAUT_EMOJI === 'true';

const withIcon = (name, s, { emoji = EMOJI_ON_DEFAULT } = {}) =>
  emoji ? `${ICONS[name] || ICONS.default} ${s}` : s;


export function summarizeToolCall(fnName, args = {}, opts = {}) {
  const safeArgs = redactArgs(fnName, args);

  const selector = pickArg(safeArgs, ['selector','xpath','css','role','testId']);
  const text     = pickArg(safeArgs, ['text','value','keys','input','query','label']);
  const url      = pickArg(safeArgs, ['url','href','to']);
  const file     = pickArg(safeArgs, ['filePath','fileName','downloadPath']);
  const x        = pickArg(safeArgs, ['x']);
  const y        = pickArg(safeArgs, ['y']);
  const timeout  = pickArg(safeArgs, ['timeoutMs','timeout']);

  const sel = selector ? ` (${truncateMiddle(selector, 60)})` : '';
  const val = text ? ` "${truncateMiddle(text, 60)}"` : '';
  const tmo = timeout ? ` [≤${timeout}ms]` : '';

  switch (fnName) {
    case 'navigate':     return withIcon('navigate',     `Navigate to ${truncateMiddle(url || '(no url)', 80)}`, opts);
    case 'click_text':   return withIcon('click_text',   `Click text${val}`, opts);
    case 'click':        return withIcon('click',        `Click element${sel}`, opts);
    case 'type':
    case 'fill':         return withIcon('type',         `Type${val}${selector ? ` into ${truncateMiddle(selector, 60)}` : ''}`, opts);
    case 'press':        return withIcon('press',        `Press key${val || ''}${selector ? ` in ${truncateMiddle(selector, 60)}` : ''}`, opts);
    case 'hover':        return withIcon('hover',        `Hover over${sel || val || ''}`, opts);
    case 'wait_for_selector':
                        return withIcon('wait_for_selector', `Wait for${sel}${tmo}`, opts);
    case 'wait':         return withIcon('wait',         `Wait${tmo || ''}`, opts);
    case 'screenshot':   return withIcon('screenshot',   `Capture screenshot${selector ? ` of ${truncateMiddle(selector, 60)}` : ''}`, opts);
    case 'get_dom':      return withIcon('get_dom',      `Inspect DOM (focused extract)`, opts);
    case 'check_text':   return withIcon('check_text',   `Check page for${val || ' specific text'}`, opts);
    case 'scroll':       return withIcon('scroll',       `Scroll to coords (${x ?? '?'}, ${y ?? '?'})`, opts);
    case 'upload_file':  return withIcon('upload_file',  `Upload file ${truncateMiddle(file || '(unknown)', 60)}${selector ? ` via ${truncateMiddle(selector, 60)}` : ''}`, opts);
    case 'download_file':
                        return withIcon('download_file', `Download file to ${truncateMiddle(file || '(unknown)', 60)}`, opts);
    case 'expand_menu':  return withIcon('expand_menu',  `Expand menu${sel || ''}`, opts);
    case 'set_viewport': return withIcon('set_viewport', `Set viewport ${safeArgs?.width}×${safeArgs?.height}`, opts);
    default:
      return withIcon('default', `Run ${fnName} with ${truncateMiddle(JSON.stringify(safeArgs ?? {}), 80)}`, opts);
  }
}

export function summarizeTurnIntentFromMessage(msg, opts = {}) {
  try {
    if (msg?.tool_calls?.length) {
      return msg.tool_calls
        .map(c => summarizeToolCall(c.function?.name || 'unknown', JSON.parse(c.function?.arguments || '{}'), opts))
        .join(' → ');
    }
    if (msg?.content) return `Reasoning: ${truncateMiddle(msg.content, 120)}`;
  } catch {}
  return 'No intent detected';
}
