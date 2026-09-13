// @ts-check
/*
 * Browser-loadable form of the owned Chat_View sanitizer (Requirements 12.5,
 * 12.6). The source of truth is `src/orchestrator/sanitizer.ts`, which is the
 * host-free, unit-tested module; this file is its plain-script mirror so the
 * webview can run the same transform without a bundler. The two are kept in
 * lock-step: the logic below is a line-for-line port of the TypeScript module,
 * so the tests over `sanitizeHtml` in `src/orchestrator/sanitizer.ts` cover the
 * behavior shipped here.
 *
 * It exposes `window.baitonSanitizeHtml(html)`, which the entry script runs on
 * every piece of rendered markdown before insertion into the DOM. The renderer
 * is never trusted on its own (Req 12.1, 19.5).
 */
(function () {
  'use strict';

  /** Whether an attribute name is an `on*` event handler (case-insensitive). */
  function isEventHandlerName(name) {
    return /^on/i.test(name);
  }

  /**
   * Whether an attribute value (with any surrounding quotes) resolves to a
   * `javascript:` URI scheme. Surrounding quotes, numeric character references,
   * and whitespace/control characters browsers ignore are normalized away so
   * obfuscated forms are still caught.
   */
  function usesJavascriptScheme(rawValue) {
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/&#x([0-9a-f]+);?/gi, function (_m, hex) {
      return String.fromCodePoint(parseInt(hex, 16));
    });
    value = value.replace(/&#(\d+);?/g, function (_m, dec) {
      return String.fromCodePoint(parseInt(dec, 10));
    });
    value = value.replace(/[\u0000-\u0020]+/g, '');
    return /^javascript:/i.test(value);
  }

  /**
   * Remove `on*` event-handler attributes and `javascript:`-scheme attribute
   * values from a tag's raw attribute text, preserving every other attribute.
   */
  function scrubAttributes(attrs) {
    const attrPattern = /(\s+)([^\s=/>]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    let result = '';
    let match;
    let lastIndex = 0;
    while ((match = attrPattern.exec(attrs)) !== null) {
      result += attrs.slice(lastIndex, match.index);
      lastIndex = attrPattern.lastIndex;

      const leadingWs = match[1];
      const attrName = match[2];
      const rawValue = match[4];

      if (isEventHandlerName(attrName)) {
        result += leadingWs.length > 1 ? leadingWs.slice(0, -1) : '';
        continue;
      }
      if (rawValue !== undefined && usesJavascriptScheme(rawValue)) {
        result += leadingWs.length > 1 ? leadingWs.slice(0, -1) : '';
        continue;
      }
      result += match[0];
    }
    result += attrs.slice(lastIndex);
    return result;
  }

  /**
   * Remove script/style elements, `on*` event-handler attributes, and
   * `javascript:`-scheme attribute values from `html`, preserving all other
   * markup unchanged (Req 12.5).
   */
  function sanitizeHtml(html) {
    let out = html;
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    out = out.replace(/<\/?(?:script|style)\b[^>]*>/gi, '');
    out = out.replace(
      /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g,
      function (_tag, name, attrs, selfClose) {
        const cleaned = scrubAttributes(attrs);
        return '<' + name + cleaned + selfClose + '>';
      }
    );
    return out;
  }

  // Expose to the entry script.
  window.baitonSanitizeHtml = sanitizeHtml;
})();
