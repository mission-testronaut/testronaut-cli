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

export function summarizeToolCall(fnName, args = {}) {
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
    case 'navigate': return `Navigate to ${truncateMiddle(url || '(no url)', 80)}`;
    case 'click_text': return `Click text${val}`;
    case 'click': return `Click element${sel}`;
    case 'type':
    case 'fill': return `Type${val}${selector ? ` into ${truncateMiddle(selector, 60)}` : ''}`;
    case 'press': return `Press key${val || ''}${selector ? ` in ${truncateMiddle(selector, 60)}` : ''}`;
    case 'hover': return `Hover over${sel || val || ''}`;
    case 'wait_for_selector': return `Wait for${sel}${tmo}`;
    case 'wait': return `Wait${tmo || ''}`;
    case 'screenshot': return `Capture screenshot${selector ? ` of ${truncateMiddle(selector, 60)}` : ''}`;
    case 'get_dom': return `Inspect DOM (focused extract)`;
    case 'check_text': return `Check page for${val || ' specific text'}`;
    case 'scroll': return `Scroll to coords (${x ?? '?'}, ${y ?? '?'})`;
    case 'upload_file': return `Upload file ${truncateMiddle(file || '(unknown)', 60)}${selector ? ` via ${truncateMiddle(selector, 60)}` : ''}`;
    case 'download_file': return `Download file to ${truncateMiddle(file || '(unknown)', 60)}`;
    case 'expand_menu': return `Expand menu${sel || ''}`;
    case 'set_viewport': return `Set viewport ${safeArgs?.width}×${safeArgs?.height}`;
    default:
      return `Run ${fnName} with ${truncateMiddle(JSON.stringify(safeArgs ?? {}), 80)}`;
  }
}

export function summarizeTurnIntentFromMessage(msg) {
  try {
    if (msg?.tool_calls?.length) {
      return msg.tool_calls
        .map(c => summarizeToolCall(c.function?.name || 'unknown', JSON.parse(c.function?.arguments || '{}')))
        .join(' → ');
    }
    if (msg?.content) return `Reasoning: ${truncateMiddle(msg.content, 120)}`;
  } catch {}
  return 'No intent detected';
}
