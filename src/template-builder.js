/*
 * Backpack Capture — turns a finished capture session into a replayable
 * template (the ordered list of pages that session visited).
 *
 * Deliberately records *addresses*, not clicks: every Classroom and Genesis
 * page that carries real content has its own URL, so replaying means
 * driving one tab through those URLs - no dependence on Google's generated
 * markup, which changes without notice and would make click replay brittle.
 *
 * No chrome.* dependency, so it can be tested outside the browser.
 */
(function (global) {
  const PROMPT_LABEL = "Switch the view (List View / Daily View), then press Done.";

  // Genesis's List View / Daily View toggle swaps the schedule content in
  // place without changing the URL (confirmed real - see docs/DESIGN.md), so
  // a URL-only replay would only ever get whichever view loads by default.
  // Capturing one Genesis page more than once in a session is exactly what
  // toggling that view looks like, so replay asks the person to do it again.
  function buildSteps(pages) {
    const sites = global.BackpackSites;
    const counts = new Map();
    const visited = [];
    for (const page of pages || []) {
      const url = page && page.url;
      if (!url || !sites.supportedSite(url)) continue;
      const seen = (counts.get(url) || 0) + 1;
      counts.set(url, seen);
      if (seen === 1) visited.push(url);
    }

    const steps = [];
    for (const url of visited) {
      steps.push({ kind: "page", url });
      const site = sites.supportedSite(url);
      if (site && site.name === "Genesis Parent Portal" && counts.get(url) > 1) {
        steps.push({ kind: "prompt", url, label: PROMPT_LABEL });
      }
    }
    return steps;
  }

  function defaultName(date) {
    return `Route from ${(date || new Date()).toISOString().slice(0, 10)}`;
  }

  function pageCount(steps) {
    return (steps || []).filter((s) => s.kind === "page").length;
  }

  global.BackpackTemplates = { buildSteps, defaultName, pageCount, PROMPT_LABEL };
})(globalThis);
