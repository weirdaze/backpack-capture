/*
 * Backpack Capture — generic DOM reduction primitive shared by every
 * adapter. This file has no chrome.* dependency and no adapter-specific
 * knowledge (no aria-label assumptions, no Genesis card-shape assumptions)
 * — it just strips noise and flattens text. Each adapter's own reducer
 * (src/reducer.js for Classroom, src/genesis-reducer.js for Genesis) wraps
 * this with its own expected-shape assertion and login-wall heuristic,
 * because what counts as "the real payload" differs per source: Classroom
 * carries it in aria-label, Genesis carries it in plain nested div text
 * with no semantic attributes at all (confirmed against a real capture —
 * see docs/DESIGN.md).
 */
(function (global) {
  const STRIP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE"]);
  const KEEP_ATTRS_PREFIXES = ["data-"];
  const KEEP_ATTRS = new Set(["aria-label", "role", "title", "href", "datetime"]);

  function shouldKeepAttr(name) {
    if (KEEP_ATTRS.has(name)) return true;
    return KEEP_ATTRS_PREFIXES.some((p) => name.startsWith(p));
  }

  function isDataUri(value) {
    return typeof value === "string" && value.trim().startsWith("data:");
  }

  // Recursively reduces a DOM node into a plain-object tree: only tag name,
  // whitelisted attributes, and text. Returns null for nodes with no signal
  // (no kept attrs, no text, no kept children) so empty wrapper divs
  // collapse away instead of bloating the output. Never anchors on class
  // names — Google's and Genesis's are both generated/unstable.
  function reduceNode(node) {
    if (node.nodeType === Node.COMMENT_NODE) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      return text ? { t: text } : null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (STRIP_TAGS.has(node.tagName)) return null;
    if (node.tagName === "IMG") return null; // no useful text, may carry data: URIs

    const attrs = {};
    for (const attr of node.attributes || []) {
      if (!shouldKeepAttr(attr.name)) continue;
      if (isDataUri(attr.value)) continue;
      attrs[attr.name] = attr.value;
    }

    const children = [];
    for (const child of node.childNodes) {
      const reduced = reduceNode(child);
      if (reduced) children.push(reduced);
    }

    const hasSignal = Object.keys(attrs).length > 0 || children.length > 0;
    if (!hasSignal) return null;

    const out = { tag: node.tagName.toLowerCase() };
    if (Object.keys(attrs).length) out.attrs = attrs;
    if (children.length) out.children = children;
    return out;
  }

  // Flattens the reduced tree into one readable text blob: a line per
  // aria-label-bearing node (the semantic payload on sources like
  // Classroom) plus one line per plain text run (the payload on sources
  // like Genesis, which has no semantic attributes at all).
  function flattenToText(reducedTree) {
    const lines = [];
    function walk(node) {
      if (!node) return;
      if (node.t) {
        lines.push(node.t);
        return;
      }
      const attrs = node.attrs || {};
      const parts = [];
      if (attrs["aria-label"]) parts.push(`[aria-label] ${attrs["aria-label"]}`);
      if (attrs["role"]) parts.push(`(role=${attrs["role"]})`);
      if (attrs["title"] && attrs["title"] !== attrs["aria-label"]) parts.push(`(title: ${attrs["title"]})`);
      if (attrs["datetime"]) parts.push(`(datetime: ${attrs["datetime"]})`);
      if (attrs["href"]) parts.push(`(href: ${attrs["href"]})`);
      for (const [name, value] of Object.entries(attrs)) {
        if (name.startsWith("data-")) parts.push(`(${name}: ${value})`);
      }
      if (parts.length) lines.push(parts.join(" "));
      for (const child of node.children || []) walk(child);
    }
    walk(reducedTree);
    // Collapse consecutive duplicate lines — very common with both
    // Classroom's and Genesis's deeply nested wrapper divs re-stating the
    // same content at every level — without disturbing distinct content.
    const deduped = [];
    for (const line of lines) {
      if (deduped[deduped.length - 1] !== line) deduped.push(line);
    }
    return deduped.join("\n");
  }

  function reduce(rootElement) {
    const tree = reduceNode(rootElement) || { tag: "div" };
    const text = flattenToText(tree);
    return { tree, text, charCount: text.length };
  }

  global.BackpackCoreReduce = { reduceNode, flattenToText, reduce };
})(typeof window !== "undefined" ? window : globalThis);
