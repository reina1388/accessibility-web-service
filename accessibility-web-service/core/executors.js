const path = require('path');
const { checkExplanationCache, saveExplanationCache } = require('./cache');

let axeCorePath;
try {
  axeCorePath = require.resolve('axe-core/axe.min.js');
} catch (e) {
  axeCorePath = null;
}

async function ensureAxeInjected(page) {
  const alreadyInjected = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (alreadyInjected) return;
  if (!axeCorePath) {
    throw new Error('axe-core 패키지를 찾을 수 없습니다. npm install을 실행했는지 확인하세요.');
  }
  await page.addScriptTag({ path: axeCorePath });
}

async function runAxeScan(page, options) {
  await ensureAxeInjected(page);
  return page.evaluate(async (opts) => {
    const context = opts.selector ? document.querySelector(opts.selector) || document : document;
    const axeOptions = { resultTypes: ['violations'] };
    if (opts.runOnly && opts.runOnly.length) axeOptions.runOnly = opts.runOnly;
    // eslint-disable-next-line no-undef
    return await window.axe.run(context, axeOptions);
  }, options || {});
}

async function inspectElement(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const attributes = {};
    for (const attr of el.attributes) attributes[attr.name] = attr.value;
    return {
      found: true,
      outerHtml: el.outerHTML.slice(0, 500),
      attributes,
      computedStyle: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      },
      rect: { width: rect.width, height: rect.height },
    };
  }, selector);
}

async function verifyFix(page, { selector, ruleId, attributes, styles }) {
  await ensureAxeInjected(page);
  return page.evaluate(
    async ({ selector, ruleId, attributes, styles }) => {
      const el = document.querySelector(selector);
      if (!el) return { applied: false, reason: '요소를 찾을 수 없습니다.' };

      const originalAttrs = {};
      Object.keys(attributes || {}).forEach((key) => {
        originalAttrs[key] = el.getAttribute(key);
      });
      const originalStyleText = el.style.cssText;

      Object.entries(attributes || {}).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
      Object.entries(styles || {}).forEach(([key, value]) => {
        el.style[key] = value;
      });

      let stillViolating = false;
      let error = null;
      try {
        // eslint-disable-next-line no-undef
        const results = await window.axe.run(document, { runOnly: [ruleId], resultTypes: ['violations'] });
        const rule = results.violations.find((v) => v.id === ruleId);
        stillViolating =
          !!rule &&
          rule.nodes.some((n) => {
            try {
              return document.querySelector(n.target[0]) === el;
            } catch (e) {
              return false;
            }
          });
      } catch (e) {
        error = e.message;
      }

      Object.entries(originalAttrs).forEach(([key, value]) => {
        if (value === null) el.removeAttribute(key);
        else el.setAttribute(key, value);
      });
      el.style.cssText = originalStyleText;

      return { applied: true, resolved: !stillViolating, error };
    },
    { selector, ruleId, attributes, styles }
  );
}

function computeContrastLocally(fg, bg) {
  const l1 = relativeLuminance(parseColor(fg));
  const l2 = relativeLuminance(parseColor(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return {
    ratio: Math.round(ratio * 100) / 100,
    passesAA_normalText: ratio >= 4.5,
    passesAA_largeText: ratio >= 3,
    passesAAA_normalText: ratio >= 7,
  };
}

function parseColor(str) {
  const rgbMatch = str.match(/rgba?\(([^)]+)\)/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((n) => parseFloat(n.trim()));
    return { r: parts[0], g: parts[1], b: parts[2] };
  }
  const hex = str.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const int = parseInt(full, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

async function executeTool(name, args, page, domain) {
  switch (name) {
    case 'axe_scan':
      return runAxeScan(page, args);
    case 'inspect_element':
      return inspectElement(page, args.selector);
    case 'compute_contrast':
      return computeContrastLocally(args.foreground, args.background);
    case 'verify_fix':
      return verifyFix(page, args);
    case 'check_cache':
      return checkExplanationCache(domain, args.ruleId);
    case 'save_explanation_cache':
      return saveExplanationCache(domain, args);
    default:
      return { error: `알 수 없는 도구: ${name}` };
  }
}

module.exports = { executeTool };
