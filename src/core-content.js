/*
 * Backpack Capture — shared content-script orchestration.
 *
 * Settle detection, the capture toast, envelope assembly, and the
 * auto-trigger/scroll-recapture wiring are identical across adapters —
 * only the reduce function, the account/id extraction, and whether a
 * scroll-to-bottom sweep makes sense differ (Classroom's stream lazy-loads
 * on scroll; Genesis's schedule page does not). This factory takes an
 * adapter config and wires up the whole flow, so each adapter's own
 * content script (content.js, genesis-content.js) stays a short config
 * file instead of duplicating settle/toast/messaging logic.
 */
(function (global) {
  const SETTLE_QUIET_MS = 750;
  const SETTLE_CEILING_MS = 10000;
  const AUTO_CAPTURE_COOLDOWN_MS = 5000;
  const SESSION_KEY = "backpack_session"; // written by background.js

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

      quietTimer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(ceiling);
        resolve();
      }, SETTLE_QUIET_MS);
    });
  }

  // Scrolls to the bottom in steps (giving lazy-load a chance to fire
  // between each one) then back to top. Only meaningful for sources that
  // defer content until it scrolls into view — adapters that don't need
  // this (Genesis's schedule page renders in full immediately) skip it via
  // config.scrollSweep = false.
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

  // options: { onUndo, actions: [{label, onClick}], sticky }
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

    const actions = [...(opts.actions || [])];
    if (opts.onUndo) actions.push({ label: "Undo", onClick: opts.onUndo });
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.style.cssText = "background:transparent;border:1px solid #4fd1c5;color:#4fd1c5;border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;flex:none;";
      btn.addEventListener("click", () => {
        action.onClick();
        toast.remove();
      });
      toast.appendChild(btn);
    }

    document.body.appendChild(toast);
    if (!opts.sticky) {
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 8000);
    }
  }

  // config: {
  //   adapter: "classroom" | "genesis",
  //   adapterVersion: number,
  //   reduce: (rootElement, {url}) => {text, charCount, shapeOk, loginWall},
  //   idFromUrl: (url) => string | number | null,   // account_index equivalent
  //   scrollSweep: boolean,                          // do the scroll-to-bottom sweep on initial load
  //   retry: { maxAttempts, delayMs } | undefined,
  //     // Re-settle and re-reduce up to maxAttempts times (waiting delayMs
  //     // between tries) while the page isn't ready yet: reduced.viewReady
  //     // is false (Classroom mid-navigation, only another class's view
  //     // rendered so far), or - with retryOnBadShape - !shapeOk.
  //   retryOnBadShape: boolean,
  //     // Also treat !shapeOk as "not loaded yet" before accepting it as
  //     // "adapter may be broken". Needed for sources whose real content
  //     // loads async after the page's own initial paint settles —
  //     // confirmed real on Genesis, whose schedule cards arrive via a
  //     // separate AJAX call and can still show its "One moment..."
  //     // placeholder when the DOM's mutation-quiet period fires.
  // }
  //
  // A mutation-quiet period alone can't tell "loaded" from "paused while
  // loading": Classroom's loading spinner goes quiet long enough to pass it.
  function createCaptureRunner(config) {
    let captureInFlight = false;
    let lastAutoCaptureAt = 0;

    function buildEnvelope(reduced) {
      const now = new Date();
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        captured_at: now.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source_url: location.href,
        account_index: config.idFromUrl(location.href),
        adapter: config.adapter,
        adapter_version: config.adapterVersion,
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
        if ((trigger === "auto" || trigger === "navigate") && config.scrollSweep) {
          await scrollThroughPage();
        }
        await waitForSettle();

        const notReady = (r) =>
          !r.loginWall && (r.viewReady === false || r.needsRefresh || (config.retryOnBadShape && !r.shapeOk));
        let reduced = config.reduce(document.body, { url: location.href });
        if (config.retry) {
          const { maxAttempts, delayMs } = config.retry;
          for (let attempt = 0; attempt < maxAttempts && notReady(reduced); attempt++) {
            await new Promise((r) => setTimeout(r, delayMs));
            await waitForSettle();
            reduced = config.reduce(document.body, { url: location.href });
          }
        }

        if (reduced.viewReady === false) {
          // Storing this would label one page's content with another page's
          // address - worse than capturing nothing.
          showToast("Backpack: this page was still loading, nothing captured. Scroll or tap Capture to try again.");
          return;
        }

        // Classroom's own SPA can get stuck mid-navigation and say so
        // directly (reduced.needsRefresh - see reducer.js#looksStuckNeedingRefresh),
        // confirmed real after a rapid run of automated page-to-page
        // navigations. Waiting alone (the retries above) doesn't clear it,
        // so force one real reload and let the fresh load capture it from
        // scratch, same as the site's own banner says to do. Capped at one
        // attempt per distinct page (sessionStorage, keyed by path) so a
        // page that's genuinely stuck for good doesn't reload forever.
        if (reduced.needsRefresh) {
          const reloadKey = `__backpack_reload_attempted__${location.pathname}`;
          let alreadyReloaded = false;
          try {
            alreadyReloaded = Boolean(sessionStorage.getItem(reloadKey));
            if (!alreadyReloaded) sessionStorage.setItem(reloadKey, "1");
          } catch (e) {
            // sessionStorage unavailable (e.g. a locked-down profile) - fall
            // through and capture whatever's there rather than looping
          }
          if (!alreadyReloaded) {
            location.reload();
            return;
          }
        }

        const envelope = buildEnvelope(reduced);

        if (envelope.status === "login_wall") {
          showToast("Backpack: this looks like a sign-in page, nothing captured.");
          return;
        }

        // detailLinks/courseLinks (Classroom only, see
        // src/reducer.js#extractDetailLinks and #extractCourseLinks) ride
        // along on the same message so the background worker can optionally
        // drive this tab through them — never sent for a page that isn't a
        // clean capture, since a login-wall or broken-shape page's "links"
        // aren't trustworthy.
        const detailLinks = envelope.status === "ok" ? reduced.detailLinks || [] : [];
        const courseLinks = envelope.status === "ok" ? reduced.courseLinks || [] : [];
        const response = await chrome.runtime.sendMessage({
          type: "STORE_CAPTURE",
          envelope,
          detailLinks,
          courseLinks,
        });
        if (!response || !response.ok) {
          showToast("Backpack: capture failed to save.");
          return;
        }

        const label =
          envelope.status === "adapter_may_be_broken"
            ? "captured (this site's layout may have changed — check it)"
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

      // Replay drives this tab through a saved route. One step can't be done
      // by address alone (Genesis swaps List/Daily View in place), so replay
      // asks the person to do it rather than clicking the page itself.
      if (message && message.type === "SHOW_REPLAY_PROMPT") {
        showToast(message.label, {
          sticky: true,
          actions: [
            { label: "Done", onClick: () => chrome.runtime.sendMessage({ type: "REPLAY_STEP_DONE", skipped: false }) },
            { label: "Skip", onClick: () => chrome.runtime.sendMessage({ type: "REPLAY_STEP_DONE", skipped: true }) },
          ],
        });
        sendResponse({ ok: true });
        return true;
      }

      if (message && message.type === "SHOW_REPLAY_TOAST") {
        showToast(message.message, { sticky: Boolean(message.sticky) });
        sendResponse({ ok: true });
        return true;
      }

      return undefined;
    });

    // Nothing is captured automatically unless the person pressed "Start
    // capture" in the popup. A one-off "Capture just this page"
    // (MANUAL_CAPTURE above) still works any time.
    async function sessionActive() {
      try {
        const data = await chrome.storage.local.get(SESSION_KEY);
        return Boolean(data[SESSION_KEY] && data[SESSION_KEY].active);
      } catch (e) {
        return false; // the extension was reloaded underneath this page
      }
    }

    async function autoCapture(trigger) {
      if (!(await sessionActive())) return;
      if (Date.now() - lastAutoCaptureAt < AUTO_CAPTURE_COOLDOWN_MS) return;
      lastAutoCaptureAt = Date.now();
      runCapture(trigger);
    }

    setTimeout(() => autoCapture("auto"), 1000);

    // Pressing Start while this page is already open captures it right away.
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = area === "local" && changes[SESSION_KEY];
      if (!change) return;
      const wasActive = Boolean(change.oldValue && change.oldValue.active);
      const isActive = Boolean(change.newValue && change.newValue.active);
      if (isActive && !wasActive && document.visibilityState === "visible") {
        lastAutoCaptureAt = 0;
        autoCapture("auto");
      }
    });

    function scheduleRecapture(idleTimerRef, delayMs, trigger) {
      if (idleTimerRef.id) clearTimeout(idleTimerRef.id);
      idleTimerRef.id = setTimeout(() => autoCapture(trigger), delayMs);
    }

    const scrollIdleTimer = {};
    window.addEventListener(
      "scroll",
      () => scheduleRecapture(scrollIdleTimer, 1500, "scroll-settle"),
      { passive: true }
    );

    // A click can switch between views the page never navigates or
    // scrolls for (confirmed real: Genesis's List View / Daily View
    // toggle swaps the schedule content in place on the same URL) - a
    // person clicking something and pausing to look is the same "looking
    // at this now" signal scroll-pause already covers, so recapture there
    // too instead of requiring a manual "Capture this tab" for every view.
    const clickIdleTimer = {};
    document.addEventListener(
      "click",
      () => scheduleRecapture(clickIdleTimer, 1500, "click-settle"),
      { passive: true, capture: true }
    );

    // Single-page apps (Classroom) change the URL without reloading, so the
    // initial "auto" capture never runs for the next page. Content scripts
    // can't see the page's own history.pushState calls, so poll the URL.
    let lastHref = location.href;
    const navIdleTimer = {};
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      scheduleRecapture(navIdleTimer, 1500, "navigate");
    }, 500);

    return { runCapture };
  }

  global.BackpackCoreContent = { createCaptureRunner };
})(typeof window !== "undefined" ? window : globalThis);
