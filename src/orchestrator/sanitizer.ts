/**
 * The Chat_View's owned HTML sanitizer (Requirements 12.5, 12.6).
 *
 * The Markdown_Renderer turns assistant text into HTML; that HTML is never
 * trusted on its own. `sanitizeHtml` is the owned, host-free step that runs on
 * the renderer's output before it is inserted into the webview DOM. It removes
 * the constructs that could execute code — `<script>` and `<style>` elements,
 * `on*` event-handler attributes, and attributes whose value uses a
 * `javascript:` URI scheme — while preserving all other markup unchanged (Req
 * 12.5).
 *
 * The implementation is a pure string transform with no dependency on the DOM
 * or any browser API, so it can be invoked and asserted in isolation without a
 * running VS Code host (Req 12.6). It runs in the webview at render time but is
 * authored and unit-tested as a plain module.
 */

/**
 * Remove script/style elements, `on*` event-handler attributes, and
 * `javascript:`-scheme attribute values from `html`, preserving all other
 * markup unchanged (Req 12.5). Pure and host-free (Req 12.6).
 */
export function sanitizeHtml(html: string): string {
  let out = html;
  // Drop <script>…</script> and <style>…</style> including their content. The
  // `[\s\S]` class matches across newlines; the closing tag match is
  // case-insensitive and tolerates attributes and whitespace on the open tag.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // Also drop any self-closing or unterminated script/style open tags that
  // survive (e.g. `<script src=...>` with no matching close), so no executable
  // element start leaks through.
  out = out.replace(/<\/?(?:script|style)\b[^>]*>/gi, '');

  // Scrub attributes on every remaining tag: strip `on*` handlers and any
  // attribute whose value resolves to a `javascript:` scheme, leaving the rest
  // of the tag (and all other markup) untouched.
  out = out.replace(/<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, (_tag, name, attrs, selfClose) => {
    const cleaned = scrubAttributes(attrs);
    return `<${name}${cleaned}${selfClose}>`;
  });

  return out;
}

/**
 * Remove `on*` event-handler attributes and `javascript:`-scheme attribute
 * values from a tag's raw attribute text, preserving every other attribute
 * (including its original quoting and spacing) unchanged.
 */
function scrubAttributes(attrs: string): string {
  // Matches: leading whitespace, an attribute name, and an optional value that
  // is double-quoted, single-quoted, or unquoted. Value-less attributes match
  // with the value groups empty.
  const attrPattern = /(\s+)([^\s=/>]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let result = '';
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = attrPattern.exec(attrs)) !== null) {
    // Preserve any text between the previous match and this one verbatim so
    // stray whitespace or unusual formatting survives.
    result += attrs.slice(lastIndex, match.index);
    lastIndex = attrPattern.lastIndex;

    const leadingWs = match[1];
    const attrName = match[2];
    const rawValue = match[4]; // includes surrounding quotes when quoted

    if (isEventHandlerName(attrName)) {
      // Drop the attribute entirely, but keep its leading whitespace so
      // neighbouring attributes stay separated.
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

/** Whether an attribute name is an `on*` event handler (case-insensitive). */
function isEventHandlerName(name: string): boolean {
  return /^on/i.test(name);
}

/**
 * Whether an attribute value (with any surrounding quotes) resolves to a
 * `javascript:` URI scheme. Leading/trailing whitespace, HTML entities for the
 * scheme's characters, and embedded control characters are normalized away
 * before the check so obfuscated `java\tscript:` / `&#106;avascript:` forms are
 * still caught.
 */
function usesJavascriptScheme(rawValue: string): boolean {
  let value = rawValue;
  // Strip a single matching pair of surrounding quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // Decode numeric character references so encoded schemes are unmasked.
  value = value.replace(/&#x([0-9a-f]+);?/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
  value = value.replace(/&#(\d+);?/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
  // Remove whitespace and control characters that browsers ignore inside the
  // scheme portion of a URI. The control-character range is intentional — those
  // bytes are exactly what a masked `javascript:` scheme hides behind.
  // eslint-disable-next-line no-control-regex
  value = value.replace(/[\u0000-\u0020]+/g, '');
  return /^javascript:/i.test(value);
}
