import * as cheerio from 'cheerio';

function compact(value, maxLength = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return compact(String(value ?? '').split(/[?#]/, 1)[0], 500) || null;
  }
}

function unique(values, limit) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function controlLabel($, element) {
  const node = $(element);
  const id = node.attr('id');
  const explicitLabel = id
    ? $('label').filter((_, label) => $(label).attr('for') === id).first().text()
    : '';
  return compact(
    node.attr('aria-label')
      || explicitLabel
      || node.closest('label').text()
      || node.attr('placeholder')
      || node.text(),
    120,
  );
}

function safeSelectorAttribute(value) {
  return compact(value, 100).replace(/[^A-Za-z0-9_.:-]/g, '');
}

function selectorFor($, element, fallbackIndex) {
  const node = $(element);
  const id = safeSelectorAttribute(node.attr('id'));
  if (id) return `#${id}`;
  const tag = String(element.tagName || element.name || 'section').toLowerCase();
  return `${tag}:nth-of-type(${fallbackIndex + 1})`;
}

/**
 * Extract bounded, value-free evidence from a DOM snapshot already collected by
 * Testronaut. Input values, query strings, hashes, and body text are omitted.
 */
export function buildBrowserEvidence(html, {
  url,
  previous = null,
  redactText = value => String(value ?? ''),
} = {}) {
  const currentUrl = safeUrl(url) || previous?.url || null;
  const routeChanged = Boolean(previous?.url && currentUrl && previous.url !== currentUrl);
  const base = !routeChanged && previous ? { ...previous } : {};
  const evidence = {
    ...base,
    url: currentUrl,
    previousUrl: routeChanged ? previous.url : (previous?.previousUrl || null),
    routeChanged,
  };

  if (typeof html !== 'string' || !html.includes('<')) return evidence;

  const $ = cheerio.load(html);
  const redact = value => compact(redactText(compact(value)), 160);
  const headings = unique(
    $('h1, h2, h3').map((_, element) => redact($(element).text())).get(),
    12,
  );
  const controls = [];
  $('button, a[href], input, select, textarea, [role="button"], [role="link"]').each((_, element) => {
    if (controls.length >= 20) return;
    const node = $(element);
    const tag = String(element.tagName || element.name || '').toLowerCase();
    const type = compact(node.attr('type'), 40);
    controls.push({
      tag,
      ...(node.attr('role') ? { role: compact(node.attr('role'), 40) } : {}),
      ...(type ? { type } : {}),
      ...(controlLabel($, element) ? { label: redact(controlLabel($, element)) } : {}),
      ...(node.attr('id') ? { id: safeSelectorAttribute(node.attr('id')) } : {}),
      ...(node.attr('name') ? { name: safeSelectorAttribute(node.attr('name')) } : {}),
      ...(node.attr('href') ? { href: safeUrl(node.attr('href')) } : {}),
    });
  });
  const regions = [];
  $('header, nav, main, aside, footer, form, table, [role="dialog"], [role="main"], [role="navigation"]').each((index, element) => {
    if (regions.length >= 12) return;
    const node = $(element);
    const kind = node.attr('role') || String(element.tagName || element.name || 'region').toLowerCase();
    const regionHeadings = unique(
      node.find('h1, h2, h3').map((_, heading) => redact($(heading).text())).get(),
      4,
    );
    const regionControls = unique(
      node.find('button, a[href], input, select, textarea, [role="button"], [role="link"]')
        .map((_, control) => redact(controlLabel($, control))).get(),
      8,
    );
    regions.push({
      id: `region_${regions.length + 1}`,
      kind: compact(kind, 40),
      selector: selectorFor($, element, index),
      headings: regionHeadings,
      controls: regionControls,
      counts: {
        headings: node.find('h1, h2, h3').length,
        controls: node.find('button, a[href], input, select, textarea, [role="button"], [role="link"]').length,
      },
    });
  });

  return {
    ...evidence,
    title: redact($('title').first().text()),
    headings,
    controls,
    regions,
    counts: {
      headings: $('h1, h2, h3').length,
      forms: $('form').length,
      buttons: $('button, [role="button"]').length,
      links: $('a[href], [role="link"]').length,
      inputs: $('input, select, textarea').length,
    },
  };
}

export const __browserEvidenceInternals = { compact, safeUrl };
