/*
 * Backpack Capture — Genesis-specific reduction.
 *
 * Genesis (the Genesis Parent Portal SIS, hosted at <district>/genesis/
 * parents) turned out NOT to match the frames-and-tables layout the
 * original design notes assumed — confirmed against a real capture of a
 * Cherry Hill Genesis "student summary" page: it's a single document, no
 * frames at all, and its schedule cards carry no aria-label/role/semantic
 * attributes whatsoever. The payload (class name, teacher, room, period,
 * days) lives entirely in plain nested <div> text, e.g.:
 *
 *   GEOMETRY A  FY
 *   Borrelli/Squazzo
 *   Room C203
 *   Period A
 *   Days 123456
 *
 * So unlike Classroom, there is nothing to anchor extraction on besides
 * the visible text itself. The generic core reducer already preserves
 * plain text runs in document order (see core-reduce.js), which is enough
 * to keep these card fields grouped and readable — this file only adds
 * the Genesis-specific "does this look like a real page" check and
 * login-wall/studentid handling.
 */
(function (global) {
  const core = global.BackpackCoreReduce;

  // Expected-shape assertion: a real Genesis student page has at least one
  // "Period <letter>" marker — confirmed present on every course card in
  // the real capture this adapter was built against. A miss means Genesis
  // changed its markup, or this page has no schedule/course data on it.
  function checkGenesisShape(text) {
    return /\bPeriod\s+[A-Za-z0-9]\b/.test(text);
  }

  // A login redirect on Genesis is a plain sign-in form (no /genesis/
  // parents path reached yet) with no course-card content — detect it
  // explicitly rather than storing an empty-looking "real" page.
  function looksLikeLoginWall(url, text) {
    if (!/\/genesis\/parents/i.test(url)) return true;
    const hasLoginCue = /user\s*name|password|log\s*in|sign\s*in/i.test(text);
    return hasLoginCue && !checkGenesisShape(text);
  }

  // Genesis identifies the student via a ?studentid=... query param
  // (confirmed real: parents?tab1=studentdata&tab2=studentsummary&
  // studentid=4000319), not a /u/<n>/ path segment like Classroom.
  function studentIdFromUrl(url) {
    try {
      const params = new URL(url).searchParams;
      return params.get("studentid") || null;
    } catch {
      return null;
    }
  }

  // #google_translate_element is Genesis's Google Translate widget - a
  // language dropdown with 100+ entries that carried no schedule signal at
  // all but made up ~70% of a real capture's reduced text (confirmed: 4771
  // of 6765 chars in a live capture). Excluded by id, which is stable
  // (Google's own widget mount point), not by anything Genesis-specific
  // that could churn.
  const SKIP_SELECTORS = ["#google_translate_element"];

  function reduce(rootElement, options) {
    const opts = options || {};
    const base = core.reduce(rootElement, { skipSelectors: SKIP_SELECTORS });
    return {
      ...base,
      shapeOk: checkGenesisShape(base.text),
      loginWall: looksLikeLoginWall(opts.url || "", base.text),
    };
  }

  global.BackpackGenesisReducer = {
    reduceNode: core.reduceNode,
    flattenToText: core.flattenToText,
    checkGenesisShape,
    looksLikeLoginWall,
    studentIdFromUrl,
    reduce,
  };
})(typeof window !== "undefined" ? window : globalThis);
