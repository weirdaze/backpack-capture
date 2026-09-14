/*
 * Backpack Capture — Classroom content script (thin adapter config over
 * core-content.js's shared runner). See docs/DESIGN.md for why this
 * approach (read the DOM of a session the human already opened) is used.
 */
(function () {
  window.BackpackCoreContent.createCaptureRunner({
    adapter: "classroom",
    adapterVersion: 1,
    scrollSweep: true, // Classroom's stream lazy-loads older items on scroll
    idFromUrl: (url) => window.BackpackReducer.accountIndexFromUrl(url),
    reduce: (rootElement, opts) => window.BackpackReducer.reduce(rootElement, opts),
  });
})();
