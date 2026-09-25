/*
 * Backpack Capture — scheduling rules for the automatic walk.
 *
 * Pure functions only (no chrome.* calls), so the "should it run now",
 * "which detail pages can it skip" and "what's new since the last publish"
 * decisions are unit-testable without a browser. background.js owns the
 * alarm, the window, and the crawl itself.
 */
(function (global) {
  const DEFAULTS = {
    enabled: false,
    studentId: null,
    studentName: null,
    accountIndex: 0,
    intervalHours: 4,
    // No walks overnight: nothing a parent acts on changes then, and a
    // machine's overnight sleep is exactly what leaves Classroom's SPA
    // stuck mid-walk (see DESIGN.md's circuit-breaker notes).
    quietStartHour: 22,
    quietEndHour: 6,
  };

  // A detail page (instructions, point value) rarely changes once posted,
  // so a scheduled run re-opens one only once a day; the Classwork list
  // itself - where due dates and new work appear - is walked every run.
  const DETAIL_REFRESH_MS = 24 * 60 * 60 * 1000;

  function withDefaults(settings) {
    return { ...DEFAULTS, ...(settings || {}) };
  }

  function homeUrl(accountIndex) {
    const n = Number.isInteger(Number(accountIndex)) && Number(accountIndex) >= 0 ? Number(accountIndex) : 0;
    return `https://classroom.google.com/u/${n}/h`;
  }

  function inQuietHours(date, settings) {
    const { quietStartHour: start, quietEndHour: end } = withDefaults(settings);
    if (start === end) return false;
    const h = date.getHours();
    return start < end ? h >= start && h < end : h >= start || h < end;
  }

  // Returns null when a run is due, otherwise the reason it isn't.
  function skipReason(settings, now, lastRun) {
    const s = withDefaults(settings);
    if (!s.enabled) return "disabled";
    if (!s.studentId) return "no_student";
    if (inQuietHours(now, s)) return "quiet_hours";
    if (lastRun && lastRun.startedAt) {
      const elapsed = now.getTime() - new Date(lastRun.startedAt).getTime();
      // A few minutes of slack so an hourly alarm tick landing just short
      // of the interval doesn't push the run a whole extra hour.
      if (elapsed < s.intervalHours * 3600 * 1000 - 5 * 60 * 1000) return "not_due";
    }
    return null;
  }

  // seen: { href: firstVisitedAtMs }. Drops entries older than a day, so
  // those pages get opened again on the next run.
  function pruneSeenDetails(seen, nowMs) {
    const kept = {};
    for (const [href, at] of Object.entries(seen || {})) {
      if (nowMs - at < DETAIL_REFRESH_MS) kept[href] = at;
    }
    return kept;
  }

  // Keeps each page's first-visit time, so it expires a day after it was
  // first opened rather than being renewed by every run forever.
  function mergeSeenDetails(seen, visitedHrefs, nowMs) {
    const merged = { ...(seen || {}) };
    for (const href of visitedHrefs || []) {
      if (!(href in merged)) merged[href] = nowMs;
    }
    return merged;
  }

  // Captures newer than the last successful publish. login_wall captures
  // are never stored, and schoolz dedupes by content hash anyway - this is
  // only about not re-sending hundreds of old pages every four hours.
  function capturesSince(captures, cutoffIso) {
    if (!cutoffIso) return [...(captures || [])];
    return (captures || []).filter((c) => c.captured_at > cutoffIso);
  }

  function latestCapturedAt(captures) {
    let latest = null;
    for (const c of captures || []) {
      if (!latest || c.captured_at > latest) latest = c.captured_at;
    }
    return latest;
  }

  global.BackpackAutoWalk = {
    DEFAULTS,
    DETAIL_REFRESH_MS,
    withDefaults,
    homeUrl,
    inQuietHours,
    skipReason,
    pruneSeenDetails,
    mergeSeenDetails,
    capturesSince,
    latestCapturedAt,
  };
})(globalThis);
