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

  function reduce(rootElement, options) {
    const opts = options || {};
    const base = core.reduce(rootElement);
    return {
      ...base,
      shapeOk: checkClassroomShape(base.tree),
      loginWall: looksLikeLoginWall(opts.url || "", base.tree),
    };
  }

  global.BackpackReducer = {
    reduceNode: core.reduceNode,
    flattenToText: core.flattenToText,
    checkClassroomShape,
    looksLikeLoginWall,
    accountIndexFromUrl,
    reduce,
  };
})(typeof window !== "undefined" ? window : globalThis);
