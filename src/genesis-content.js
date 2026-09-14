/*
 * Backpack Capture — Genesis content script (thin adapter config over
 * core-content.js's shared runner). No scroll-sweep: the captured Genesis
 * student-summary page renders its full shell immediately, it doesn't
 * lazy-load on scroll the way Classroom's stream does — but its schedule
 * cards DO load asynchronously via a separate AJAX call after the shell
 * settles (confirmed real: a live capture caught the page still showing
 * Genesis's own "One moment..." placeholder instead of any course card),
 * so retryOnBadShape is needed here even though scrollSweep isn't.
 */
(function () {
  window.BackpackCoreContent.createCaptureRunner({
    adapter: "genesis",
    adapterVersion: 1,
    scrollSweep: false,
    retryOnBadShape: { maxAttempts: 5, delayMs: 1500 },
    idFromUrl: (url) => window.BackpackGenesisReducer.studentIdFromUrl(url),
    reduce: (rootElement, opts) => window.BackpackGenesisReducer.reduce(rootElement, opts),
  });
})();
