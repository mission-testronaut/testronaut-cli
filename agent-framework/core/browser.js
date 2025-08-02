import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

export class Browser {
  async start() {
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();
  }

  async navigate({ url }) {
    await this.page.goto(url);
    return `Navigated to ${url}`;
  }

  async fill({ selector, text }) {
    await this.page.waitForSelector(selector);
    await this.page.fill(selector, text);
    return `Filled ${selector}`;
  }

  async click({ selector, delayMs = 2000 }) {
    await this.page.waitForSelector(selector);
    await this.page.click(selector);
    await this.page.waitForTimeout(delayMs);
    return `Clicked ${selector}`;
  }

  async get_dom({ limit = 50000 }) {
    const html = await this.page.content();
    const $ = cheerio.load(html);
    $('script, style, meta, link, noscript, iframe, canvas, svg').remove();
    return $.html().slice(0, limit);
  }

  async check_text({ text }) {
    const content = await this.page.content();
    return content.includes(text) ? `FOUND: ${text}` : `NOT FOUND: ${text}`;
  }

  async close() {
    await this.browser.close();
  }
}