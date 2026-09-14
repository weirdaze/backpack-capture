/*
 * Backpack Capture — DOM reducer for the Classroom adapter.
 *
 * Turns a live, fully-rendered Classroom subtree into a small, stable text
 * blob worth exporting. This file has no chrome.* dependency and no DOM
 * mutation side effects — it only reads — so it can be loaded standalone in
 * a test harness against a saved fixture (see test/fixtures/).
 */
(function (global) {
  const STRIP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE"]);
  const KEEP_ATTRS_PREFIXES = ["data-"];
  const KEEP_ATTRS = new Set(["aria-label", "role", "title", "href", "datetime"]);

  // Google's own class names are generated and churn between deploys — never
  // anchor extraction on them. Anchor on aria-label / role / URL shape /
  // visible text instead. See docs/BUCKET3_DESKTOP_APP_DESIGN.md.
  function shouldKeepAttr(name) {
    if (KEEP_ATTRS.has(name)) return true;
    return KEEP_ATTRS_PREFIXES.some((p) => name.startsWith(p));
  }

  function isDataUri(value) {
    return typeof value === "string" && value.trim().startsWith("data:");
  }

  // Recursively reduces a DOM node into a plain-object tree: only tag name,
  // the whitelisted attributes, and text. Returns null for nodes that carry
  // no signal at all (no kept attrs, no text, no kept children) so empty
  // wrapper divs collapse away instead of bloating the output.
  function reduceNode(node) {
    if (node.nodeType === Node.COMMENT_NODE) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      return text ? { t: text } : null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (STRIP_TAGS.has(node.tagName)) return null;

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

  // Flattens the reduced tree back into a single readable text blob: one
  // line per node that carries an aria-label (the real semantic payload —
  // see the aria-label examples in the design doc), falling back to plain
  // text runs for everything else. This is what actually gets exported,
  // rather than the nested object, so the output is diffable and small.
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
    // Collapse consecutive duplicate lines (very common with Classroom's
    // deeply nested wrapper divs re-stating the same aria-label at every
    // level) without disturbing genuinely distinct content.
    const deduped = [];
    for (const line of lines) {
      if (deduped[deduped.length - 1] !== line) deduped.push(line);
    }
    return deduped.join("\n");
  }

  // Expected-shape assertion for the Classroom adapter: at least one node
  // whose aria-label starts with Assignment:/Material:/Announcement. A miss
  // here means Google changed the DOM (or this isn't a page with work items
  // on it at all) — the caller marks the capture "adapter may be broken"
  // rather than silently storing zero items as if that were the truth.
  function checkClassroomShape(reducedTree) {
    let found = false;
    function walk(node) {
      if (found || !node) return;
      const label = node.attrs && node.attrs["aria-label"];
      if (label && /^(Assignment|Material|Announcement)/i.test(label)) {
        found = true;
        return;
      }
      for (const child of node.children || []) walk(child);
    }
    walk(reducedTree);
    return found;
  }

  // A login redirect looks structurally valid (it's a real page) but
  // contains zero assignments — detect it explicitly so it never overwrites
  // a good capture with nothing. See the design doc's failure-modes table.
  function looksLikeLoginWall(url, reducedTree) {
    if (/^https:\/\/accounts\.google\.com/.test(url)) return true;
    const text = flattenToText(reducedTree);
    const hasPasswordCue = /sign in|verify it's you|choose an account/i.test(text);
    const hasWorkItem = checkClassroomShape(reducedTree);
    return hasPasswordCue && !hasWorkItem;
  }

  function accountIndexFromUrl(url) {
    const m = /\/u\/(\d+)\//.exec(url);
    return m ? Number(m[1]) : null;
  }

  function reduce(rootElement, options) {
    const opts = options || {};
    const tree = reduceNode(rootElement) || { tag: "div" };
    const text = flattenToText(tree);
    return {
      tree,
      text,
      charCount: text.length,
      shapeOk: checkClassroomShape(tree),
      loginWall: looksLikeLoginWall(opts.url || "", tree),
    };
  }

  global.BackpackReducer = {
    reduceNode,
    flattenToText,
    checkClassroomShape,
    looksLikeLoginWall,
    accountIndexFromUrl,
    reduce,
  };
})(typeof window !== "undefined" ? window : globalThis);
