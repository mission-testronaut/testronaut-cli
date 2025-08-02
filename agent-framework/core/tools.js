import { Browser } from './browser.js';

export const TOOL_MAP = {
  navigate: (browser, args) => browser.navigate(args),
  fill: (browser, args) => browser.fill(args),
  click: (browser, args) => browser.click(args),
  get_dom: (browser, args) => browser.get_dom(args),
  check_text: (browser, args) => browser.check_text(args),
};
