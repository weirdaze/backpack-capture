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

  // Matches a Classroom work-item details page once its href is resolved to
  // an absolute URL: /u/<n>/c/<classId>/(a|m)/<itemId>/details. Confirmed
  // real for both assignments and materials against a fixture shaped after
  // an actual capture (test/fixtures/classroom-stream.html).
  const DETAIL_HREF_RE = /^https:\/\/classroom\.google\.com\/u\/\d+\/c\/[^/]+\/(a|m)\/[^/]+\/details(?:[/?#]|$)/;

  // "Assignment: Chapter 4 Reading Response, due Tomorrow" ->
  // {kind: "assignment", title: "Chapter 4 Reading Response", due: "Tomorrow"}.
  // Titles are sometimes fully quoted by Classroom ('Material: "Title"') and
  // sometimes not, and occasionally quoted plus a trailing literal word
  // ('Assignment: "Title" Assignment, due X') - only the fully-quoted case
  // is unwrapped; the messier case is left as-is rather than guessed at,
  // since this title is cosmetic (toast text) and never used for navigation.
  function parseWorkItemLabel(label) {
    const m = /^(Assignment|Material):\s*(.*?)(?:,\s*due\s+(.+))?$/i.exec(label || "");
    if (!m) return null;
    let title = m[2].trim();
    if (title.length > 1 && title.startsWith('"') && title.endsWith('"')) {
      title = title.slice(1, -1);
    }
    return { kind: m[1].toLowerCase(), title, due: m[3] ? m[3].trim() : null };
  }

  function resolveHref(href, url) {
    try {
      return new global.URL(href, url || undefined).href;
    } catch (e) {
      return null;
    }
  }

  // Finds every assignment/material this page links to its own details page
  // for — real anchors Classroom itself rendered, resolved to absolute URLs.
  // Deliberately never reconstructed from data-stream-item-id or any other
  // internal id: an item Classroom renders as a JS-driven button with no
  // href (confirmed real for some Stream-tab items) is simply left out,
  // rather than guessing a details URL that might land on the wrong page.
  //
  // Whether a link qualifies rests on the href alone (resolving to
  // /c/<class>/(a|m)/<item>/details), with kind read off that same path
  // segment - never on the aria-label matching "Assignment:"/"Material:".
  // Confirmed real that the same work item can carry a real anchor in one
  // rendering (a due-soon widget) and only a label-less JS button in
  // another (the general Stream list) - and a details page's own label
  // convention is unverified, so a link real Classwork/Stream data does
  // carry shouldn't be dropped just because its label doesn't match the
  // wording seen elsewhere. The label is used only for a cosmetic
  // title/due-date when it happens to match.
  function extractDetailLinks(reducedTree, url) {
    const seen = new Set();
    const links = [];
    function walk(node) {
      if (!node) return;
      const attrs = node.attrs;
      if (attrs && attrs.href) {
        const absolute = resolveHref(attrs.href, url);
        const m = absolute && DETAIL_HREF_RE.exec(absolute);
        if (m && !seen.has(absolute)) {
          seen.add(absolute);
          const parsed = parseWorkItemLabel(attrs["aria-label"]);
          links.push({
            href: absolute,
            kind: parsed ? parsed.kind : m[1] === "a" ? "assignment" : "material",
            title: parsed ? parsed.title : null,
            due: parsed ? parsed.due : null,
          });
        }
      }
      for (const child of node.children || []) walk(child);
    }
    walk(reducedTree);
    return links;
  }

  // A course tile/nav-entry link: /u/<n>/c/<classId>, nothing after it.
  // Confirmed real (both in the left-hand class switcher, present on every
  // Classroom page, and the homepage's own course list) as a real anchor
  // with role="menuitem". Archived classes don't appear here at all - they
  // sit behind a separate /h/archived link this pattern never matches - so
  // "every course this finds" is naturally "every active course," with no
  // separate archived/active filtering needed.
  const COURSE_HREF_RE = /^https:\/\/classroom\.google\.com\/u\/\d+\/c\/([A-Za-z0-9_-]+)(?:[/?#]|$)/;

  // A course tile/nav link resolves to that course's *Stream* page -
  // confirmed real from a homepage capture, and Google's own docs describe
  // Stream as a message board, not the assignment list (see docs/DESIGN.md
  // for the fuller evidence). What the crawl actually needs to visit is
  // that course's Classwork tab. There's no real anchor for that on the
  // homepage itself - the Classwork tab link only exists inside a class's
  // own sub-nav, one hop past where courseLinks is extracted - so, unlike
  // every other link in this file, `classworkHref` here IS constructed
  // rather than read off a real anchor. It's a narrower exception than
  // that rule usually allows: /w/<classId>/t/all is a stable, public URL
  // shape (not an opaque internal id) that a real Classwork-tab visit
  // already produced in a real capture examined while building this
  // (test/fixtures - and docs/DESIGN.md - reference it), so the risk this
  // rule normally guards against - guessing wrong and mislabeling one
  // page's content under another's address - doesn't apply the same way.
  function classworkHrefFor(classId, url) {
    const acct = accountIndexFromUrl(url) || 0;
    return `https://classroom.google.com/u/${acct}/w/${classId}/t/all`;
  }

  function extractCourseLinks(reducedTree, url) {
    const seen = new Set();
    const links = [];
    function walk(node) {
      if (!node) return;
      const attrs = node.attrs;
      if (attrs && attrs.href) {
        const absolute = resolveHref(attrs.href, url);
        const m = absolute && COURSE_HREF_RE.exec(absolute);
        if (m && isClassId(m[1]) && !seen.has(m[1])) {
          seen.add(m[1]);
          links.push({
            href: absolute,
            classworkHref: classworkHrefFor(m[1], url),
            classId: m[1],
            title: (attrs["aria-label"] || "").trim() || null,
          });
        }
      }
      for (const child of node.children || []) walk(child);
    }
    walk(reducedTree);
    return links;
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
      detailLinks: extractDetailLinks(base.tree, opts.url || ""),
      courseLinks: extractCourseLinks(base.tree, opts.url || ""),
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
    parseWorkItemLabel,
    extractDetailLinks,
    extractCourseLinks,
    reduce,
  };
})(typeof window !== "undefined" ? window : globalThis);
