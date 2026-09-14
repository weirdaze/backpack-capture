/*
 * Backpack Capture — Classroom content script.
 *
 * Auto-triggers on any classroom.google.com page, waits for the page to
 * settle (Classroom paints progressively and lazy-loads on scroll), reduces
 * the DOM, and stores a capture envelope locally. Nothing here reads
 * cookies/localStorage/credentials, submits a form, or automates a login —
 * see the "Design principles" section of docs/BUCKET3_DESKTOP_APP_DESIGN.md
 * in the schoolz repo, which this extension implements Tier 1 of.
 */
(function () {
  const SETTLE_QUIET_MS = 750;
  const SETTLE_CEILING_MS = 10000;
  const ADAPTER = "classroom";
  const ADAPTER_VERSION = 1;

  let captureInFlight = false;
  let lastAutoCaptureAt = 0;
  const AUTO_CAPTURE_COOLDOWN_MS = 5000;

  function waitForSettle() {
    return new Promise((resolve) => {
      let quietTimer = null;
      const ceiling = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, SETTLE_CEILING_MS);

      const observer = new MutationObserver(() => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          observer.disconnect();
          clearTimeout(ceiling);
          resolve();
        }, SETTLE_QUIET_MS);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Kick the quiet timer immediately in case the page is already still.
      quietTimer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(ceiling);
        resolve();
      }, SETTLE_QUIET_MS);
    });
  }

  // Classroom defers stream content until it scrolls into view — a capture
  // that never scrolled will quietly miss older items. Scroll to the bottom
  // in steps so lazy-load has a chance to fire between each one, then back
  // to top so the visible viewport matches what the parent expects to see.
  async function scrollThroughPage() {
    const scroller = document.scrollingElement || document.documentElement;
    const step = Math.max(window.innerHeight * 0.8, 400);
    let lastHeight = -1;
    for (let i = 0; i < 20; i++) {
      scroller.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 200));
      if (scroller.scrollHeight === lastHeight && scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 4) {
        break;
      }
      lastHeight = scroller.scrollHeight;
    }
    scroller.scrollTo(0, 0);
  }

  function showToast(message, options) {
    const opts = options || {};
    const existing = document.getElementById("__backpack_capture_toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "__backpack_capture_toast";
    toast.style.cssText = [
      "position:fixed", "bottom:20px", "right:20px", "z-index:2147483647",
      "background:#16211f", "color:#eafff9", "padding:10px 14px",
      "border-radius:8px", "font:13px/1.4 system-ui,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,.35)", "display:flex",
      "align-items:center", "gap:10px", "max-width:320px",
    ].join(";");

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    if (opts.onUndo) {
      const undoBtn = document.createElement("button");
      undoBtn.textContent = "Undo";
      undoBtn.style.cssText = "background:transparent;border:1px solid #4fd1c5;color:#4fd1c5;border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;flex:none;";
      undoBtn.addEventListener("click", () => {
        opts.onUndo();
        toast.remove();
      });
      toast.appendChild(undoBtn);
    }

    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 8000);
  }

  function buildEnvelope(reduced) {
    const now = new Date();
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      captured_at: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      source_url: location.href,
      account_index: window.BackpackReducer.accountIndexFromUrl(location.href),
      adapter: ADAPTER,
      adapter_version: ADAPTER_VERSION,
      char_count: reduced.charCount,
      reduced_text: reduced.text,
      status: reduced.loginWall
        ? "login_wall"
        : !reduced.shapeOk
        ? "adapter_may_be_broken"
        : reduced.charCount < 200
        ? "low_confidence"
        : "ok",
    };
  }

  async function runCapture(trigger) {
    if (captureInFlight) return;
    captureInFlight = true;
    try {
      // Only the initial load-triggered capture does the scroll-to-bottom
      // sweep (to force lazy-loaded stream items to render) and restores
      // the scroll position afterward. A capture triggered by the parent's
      // own manual scroll must never fight that scroll or jump them back.
      if (trigger === "auto") {
        await scrollThroughPage();
      }
      await waitForSettle();

      const reduced = window.BackpackReducer.reduce(document.body, { url: location.href });
      const envelope = buildEnvelope(reduced);

      if (envelope.status === "login_wall") {
        // A login redirect must never overwrite good data with nothing —
        // don't store it, just tell the parent.
        showToast("Backpack: this looks like a sign-in page, nothing captured.");
        return;
      }

      const response = await chrome.runtime.sendMessage({ type: "STORE_CAPTURE", envelope });
      if (!response || !response.ok) {
        showToast("Backpack: capture failed to save.");
        return;
      }

      const label =
        envelope.status === "adapter_may_be_broken"
          ? "captured (Classroom's layout may have changed — check it)"
          : envelope.status === "low_confidence"
          ? "captured (very little text — low confidence)"
          : "captured this page";

      showToast(`Backpack ${label}`, {
        onUndo: () => chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", id: envelope.id }),
      });
    } finally {
      captureInFlight = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "MANUAL_CAPTURE") {
      runCapture("manual").then(() => sendResponse({ ok: true }));
      return true;
    }
    return undefined;
  });

  // Auto-trigger once per navigation, after a short delay so document_idle
  // content has a chance to start painting before settle-detection begins.
  setTimeout(() => {
    lastAutoCaptureAt = Date.now();
    runCapture("auto");
  }, 1000);

  // Re-trigger on manual scroll-and-pause too, per the design doc: a parent
  // scrolling further down and pausing should (re-)capture the newly
  // revealed content, not require reopening the popup.
  let scrollIdleTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        if (Date.now() - lastAutoCaptureAt < AUTO_CAPTURE_COOLDOWN_MS) return;
        lastAutoCaptureAt = Date.now();
        runCapture("scroll-settle");
      }, 1500);
    },
    { passive: true }
  );
})();
