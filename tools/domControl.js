/**
 * domControl.js
 * --------------
 * Purpose:
 *   Centralized DOM-normalization helpers for Testronaut.
 *   These functions take a Cheerio instance and aggressively strip,
 *   normalize, and compress HTML so it’s cheaper and clearer for LLMs.
 *
 * Responsibilities:
 *   - Remove non-content tags (scripts, styles, iframes, etc.) and noisy attributes.
 *   - Collapse overly long lists/sections into truncated markers.
 *   - Reduce repeated div blocks to a representative sample.
 *   - Strip obfuscated/utility CSS classes that don’t help reasoning.
 *   - Minify whitespace in text nodes without breaking semantics.
 *
 * Related tests:
 *   Located in `tests/toolsTests/domControl.test.js`
 *
 * Used by:
 *   - tools/chromeBrowser.js (get_dom) before sending DOM to the LLM
 *   - Any future DOM-inspection tools that need a compact, semantic HTML view
 */

/**
 * Remove tags and attributes that are unlikely to help LLM reasoning.
 * - Strips: script, style, meta, link, noscript, iframe, canvas, svg
 * - Keeps only a safe whitelist of attributes on remaining elements.
 * - Removes HTML comments.
 *
 * @param {$} $ - Cheerio root
 * @returns {$} same Cheerio instance for chaining
 */
export const removeNonContentTags = async ($) => {
  $('script, style, meta, link, noscript, iframe, canvas, svg').remove();
  
  $('*').each((_, el) => {
    const $el = $(el);
    const allowedAttrs = [
      'href', 'src', 'type', 'alt', 'title',
      'placeholder', 'name', 'id', 'class', 'aria-label', 'value'
    ];

    const attrs = el.attribs;
    // const tagName = $el.get(0)?.tagName?.toLowerCase();
    // const keepEmpty = ['input', 'button', 'textarea', 'select'];

    // if (!keepEmpty.includes(tagName) && !$el.text().trim() && $el.children().length === 0) {
    //   $el.remove();
    // }

    for (const attr in attrs) {
      if (!allowedAttrs.includes(attr)) {
        $el.removeAttr(attr);
      }
    }
  });

  $('*')
    .contents()
    .each(function () {
      if (this.type === 'comment') {
        $(this).remove();
      }
    });

  return $;
}

/**
 * Collapse very long lists and container sections.
 * - For <ul>/<ol>, keeps the first `limit` <li> children and appends a
 *   sentinel <li data-collapsed="true">[...truncated]</li>.
 * - For <div>/<section>, keeps the first `limit` child elements and appends
 *   a sentinel <div data-collapsed="true">[...truncated]</div>.
 *
 * This is meant to cut down giant feeds/tables while preserving structure.
 *
 * @param {$} $ - Cheerio root
 * @param {number} [limit=10] - Max children to preserve per container
 * @returns {$} same Cheerio instance for chaining
 */
export const collapseLongContent = async ($, limit = 10) => {
  $('ul, ol').each((_, el) => {
    const $el = $(el);
    const items = $el.children('li');

    if (items.length > limit) {
      items.slice(limit).remove();
      $el.append('<li data-collapsed="true">[...truncated]</li>');
    }
  });

  $('div, section').each((_, el) => {
    const $el = $(el);
    const children = $el.children();

    if (children.length > limit) {
      children.slice(limit).remove();
      $el.append('<div data-collapsed="true">[...truncated]</div>');
    }
  });
}

/**
 * Extract logical sections of the page into named chunks.
 * - Returns an object keyed by region: header, nav, main, footer, aside, body.
 * - Each key maps to the inner HTML of that section (or '' if missing).
 * - If `focus` is a non-empty array, only the requested keys are returned.
 *
 * This is a structural pre-step for “header/nav/main/…” focus slicing.
 *
 * @param {$} $ - Cheerio root
 * @param {string[]} [focus] - Optional list of section keys to keep
 * @returns {Record<string,string>} map of sectionName -> html
 */
export const chunkBySection = async ($, focus) => {
  const chunks = {
    header: $('header').html() || '',
    nav: $('nav').html() || '',
    main: $('main').html() || '',
    footer: $('footer').html() || '',
    aside: $('aside').html() || '',
    body: $('body').html() || ''
  };

  if (Array.isArray(focus) && focus.length > 0) {
    return Object.fromEntries(
      Object.entries(chunks).filter(
        ([k]) => focus.includes(k)
      )
    );
  }

  return chunks;

  // let focusedChunks = Object.entries(chunks)
  //   .filter(([key]) => focus?.length === 0 || focus?.includes(key))
  //   .map(([, html]) => html)
  //   .join('\n');

  // return focusedChunks;

}

/**
 * Reduce repeated sibling <div> blocks that share the same class name.
 * - For each parent <body> or <div>, group child divs by `class`.
 * - If a group exceeds `maxAllowed`, remove the extras and append a
 *   sentinel <div data-collapsed="true" data-class="...">[...truncated]</div>.
 *
 * This keeps a few representative cards/rows and collapses the rest.
 *
 * @param {$} $ - Cheerio root
 * @param {number} [maxAllowed=3] - Max sibling divs per class to keep
 * @returns {$} same Cheerio instance for chaining
 */
export function reduceRepeatedDivs($, maxAllowed = 3) {
  $('body, div').each((_, parentEl) => {
    const $parent = $(parentEl);
    const children = $parent.children('div');

    // Group children divs by class name
    const classGroups = {};
    children.each((_, child) => {
      const $child = $(child);
      const className = $child.attr('class');
      if (!className) return;
      
      if (!classGroups[className]) {
        classGroups[className] = [];
      }
      classGroups[className].push(child);
    });

    // Reduce each group to maxAllowed
    for (const className in classGroups) {
      const group = classGroups[className];
      if (group.length > maxAllowed) {
        // Remove excess nodes from the DOM
        group.slice(maxAllowed).forEach(el => $(el).remove());
        $parent.append(`<div data-collapsed="true" data-class="${className}">[...truncated]</div>`);
      }
    }
  });
  return $;
}

/**
 * Remove obfuscated or hashed class names from elements.
 * Criteria for stripping:
 *   - Very short classes (len <= 2).
 *   - Lowercase+numeric hashes like "a1b2c3".
 *   - Mixed-case hashes with digits like "AbCdE1".
 *
 * The goal is to keep semantic class names (e.g. "btn-primary") and drop
 * ones that look like auto-generated hashes.
 *
 * @param {$} $ - Cheerio root
 * @returns {$} same Cheerio instance for chaining
 */
export function removeObfuscatedClassNames($) {
  $('[class]').each((_, el) => {
    const $el = $(el);
    const originalClasses = ($el.attr('class') || '').split(/\s+/);
    const filtered = originalClasses.filter(cls => {
      const isShort = cls.length <= 2;
      const isHashed = /^[a-z0-9_-]{6,}$/.test(cls) && /[0-9]/.test(cls);
      const isObviousHash = /^[A-Za-z0-9_-]{6,}$/.test(cls) && /[A-Z]/.test(cls) && /[0-9]/.test(cls);
      return !(isShort || isHashed || isObviousHash);
    });
    if (filtered.length) {
      $el.attr('class', filtered.join(' '));
    } else {
      $el.removeAttr('class');
    }
  });

  return $;
}

/**
 * Remove known auto-generated / utility CSS classes (Tailwind, MUI, etc.).
 * - Matches a broad set of patterns for spacing, layout, color, breakpoint
 *   variants, and other low-signal utility styles.
 * - Preserves any remaining classes that don’t match those patterns.
 *
 * This keeps semantic-ish classes (e.g., "btn-primary", "modal-root")
 * while stripping the utility noise that doesn’t help the LLM.
 *
 * @param {$} $ - Cheerio root
 * @returns {$} same Cheerio instance for chaining
 */
export function removeAutoGeneratedClasses($) {
  // Regex patterns for utility classes, internal prefixes, and other noise
  const utilityClassPatterns = [
    /^text-/, /^bg-/, /^p[trblxy]?-\d+/, /^m[trblxy]?-\d+/, /^w-/, /^h-/, /^rounded/, /^border/, /^hover:/,
    /^focus:/, /^group/, /^peer/, /^ring/, /^cl-/, /^md:/, /^sm:/, /^lg:/, /^xl:/, /^2xl:/, /^z-\d+/,
    /^translate/, /^flex/, /^grid/, /^justify-/, /^items-/, /^gap-/, /^shadow/, /^overflow/, /^truncate/,
    /^relative$/, /^absolute$/, /^inset/, /^top/, /^bottom/, /^left/, /^right/,
    /^opacity-/, /^transition/, /^duration-/, /^ease-/, /^cursor-/, /^select-/, /^pointer-events-/,
  ];

  $('[class]').each((_, el) => {
    const $el = $(el);
    const classes = ($el.attr('class') || '').split(/\s+/);
    const filtered = classes.filter(cls => {
      return !utilityClassPatterns.some(pattern => pattern.test(cls));
    });
    if (filtered.length) {
      $el.attr('class', filtered.join(' '));
    } else {
      $el.removeAttr('class');
    }
  });

  return $;
}

/**
 * Minify DOM by collapsing whitespace in text nodes.
 * - Collapses all runs of whitespace to a single space.
 * - Preserves whitespace in <pre>, <code>, <textarea> (where formatting matters).
 * - Keeps at least one space for purely-whitespace nodes to avoid jamming
 *   words from adjacent nodes together.
 *
 * This is intended as a low-risk token saver before sending DOM to the LLM.
 *
 * @param {$} $ - Cheerio root
 * @returns {$} same Cheerio instance for chaining
 */
export function minifyDomWhitespace($) {
  const PRESERVE_SELECTOR = 'pre, code, textarea';

  $('*').contents().each(function () {
    if (this.type !== 'text') return;

    // Skip any text node living inside pre/code/textarea
    if ($(this).closest(PRESERVE_SELECTOR).length) return;

    const orig = this.data || '';
    if (!orig) return;

    // Collapse all whitespace to single spaces
    const collapsed = orig.replace(/\s+/g, ' ');

    if (!orig.trim()) {
      // Pure whitespace → keep a single space so adjacent words don't concatenate
      this.data = ' ';
    } else {
      // Normal text → trim ends, keep single internal spaces
      this.data = collapsed.trim();
    }
  });

  return $;
}
