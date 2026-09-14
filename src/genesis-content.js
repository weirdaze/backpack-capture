/*
 * Backpack Capture — Genesis content script (thin adapter config over
 * core-content.js's shared runner). No scroll-sweep: the captured Genesis
 * student-summary page renders its full schedule immediately, it doesn't
 * lazy-load on scroll the way Classroom's stream does.
 */
(function () {
  window.BackpackCoreContent.createCaptureRunner({
    adapter: "genesis",
    adapterVersion: 1,
    scrollSweep: false,
    idFromUrl: (url) => window.BackpackGenesisReducer.studentIdFromUrl(url),
    reduce: (rootElement, opts) => window.BackpackGenesisReducer.reduce(rootElement, opts),
  });
})();
