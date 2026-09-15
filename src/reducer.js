/*
 * Backpack Capture — Classroom-specific reduction.
 *
 * Wraps the generic strip/flatten primitive (core-reduce.js) with what's
 * specific to Classroom: the expected-shape assertion (a real assignment
 * page has an aria-label starting with Assignment:/Material:/Announcement),
 * login-wall detection, and the /u/<n>/ account-index convention.
 */
(function (global) {
  const core = global.BackpackCoreReduce;

  // Expected-shape assertion for the Classroom adapter. A miss here means
  // Google changed the DOM (or this page has no work items on it at all) —
  // the caller marks the capture "adapter may be broken" rather than
  // silently storing zero items as if that were the truth.
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
    const text = core.flattenToText(reducedTree);
    const hasPasswordCue = /sign in|verify it's you|choose an account/i.test(text);
    const hasWorkItem = checkClassroomShape(reducedTree);
    return hasPasswordCue && !hasWorkItem;
  }

  function accountIndexFromUrl(url) {
    const m = /\/u\/(\d+)\//.exec(url);
    return m ? Number(m[1]) : null;
  }

  // Classroom class ids are base64 of a numeric id ("ODcyNDkxNDc4MTk4" is
  // 872491478198), both in URLs (/c/<id>, /w/<id>/t/all) and in each class
  // view's root attribute: data-p='%.@."<id>"]...'.
  function isClassId(token) {
    if (!token || token.length < 8) return false;
    try {
      const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
      return /^\d+$/.test(global.atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    } catch (e) {
      return false;
    }
  }

  function classIdFromUrl(url) {
    const m = /\/(?:c|w)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(url || "");
    return m && isClassId(m[1]) ? m[1] : null;
  }

  function classIdsIn(el) {
    const ids = [];
    for (const m of (el.getAttribute("data-p") || "").matchAll(/"([A-Za-z0-9_-]+)"/g)) {
      if (isClassId(m[1])) ids.push(m[1]);
    }
    return ids;
  }

  // Classroom never reloads between classes and keeps the previously opened
  // class's view in the DOM after switching. Confirmed real on every
  // Classwork capture in a full export: Geometry's page held Geometry's own
  // loaded views *and* English's (the class opened just before), so each
  // class's work was exported twice - once under the next class's URL.
  // Views naming a different class than the URL are left out, and the page
  // counts as ready once a view for the URL's class exists. Pages with no
  // class in the URL (home, to-do) or no class view roots keep everything
  // and never block.
  function otherClassViews(rootElement, url) {
    const urlId = classIdFromUrl(url);
    if (!urlId) return { others: [], ready: true };
    const others = [];
    let sawClassView = false;
    let sawUrlView = false;
    rootElement.querySelectorAll("[data-p]").forEach((el) => {
      const ids = classIdsIn(el);
      if (!ids.length) return;
      sawClassView = true;
      if (ids.includes(urlId)) sawUrlView = true;
      else others.push(el);
    });
    return { others, ready: !sawClassView || sawUrlView };
  }

  function reduce(rootElement, options) {
    const opts = options || {};
    const views = otherClassViews(rootElement, opts.url || "");
    const base = core.reduce(rootElement, { skipElements: views.others });
    return {
      ...base,
      shapeOk: checkClassroomShape(base.tree),
      loginWall: looksLikeLoginWall(opts.url || "", base.tree),
      viewReady: views.ready,
    };
  }

  global.BackpackReducer = {
    reduceNode: core.reduceNode,
    flattenToText: core.flattenToText,
    checkClassroomShape,
    looksLikeLoginWall,
    accountIndexFromUrl,
    classIdFromUrl,
    otherClassViews,
    reduce,
  };
})(typeof window !== "undefined" ? window : globalThis);
