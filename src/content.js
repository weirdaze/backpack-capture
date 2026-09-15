/*
 * Backpack Capture — Classroom content script (thin adapter config over
 * core-content.js's shared runner). See docs/DESIGN.md for why this
 * approach (read the DOM of a session the human already opened) is used.
 */
(function () {
  window.BackpackCoreContent.createCaptureRunner({
    adapter: "classroom",
    adapterVersion: 2,
    scrollSweep: true, // Classroom's stream lazy-loads older items on scroll
    // Waits out class-to-class navigation (reduced.viewReady). No
    // retryOnBadShape: a class with no posted work legitimately has no items.
    retry: { maxAttempts: 8, delayMs: 750 },
    idFromUrl: (url) => window.BackpackReducer.accountIndexFromUrl(url),
    reduce: (rootElement, opts) => window.BackpackReducer.reduce(rootElement, opts),
  });
})();
