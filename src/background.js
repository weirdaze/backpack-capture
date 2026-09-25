/*
 * Backpack Capture — background service worker.
 *
 * Owns the local capture store (chrome.storage.local), the capture session
 * (Start/End capture), saved templates, replay, and the optional scheduled
 * walk. The only network calls are to schoolz, and only once the parent has
 * logged in there: a Publish press, or the scheduled walk they turned on.
 */
importScripts("supported-sites.js", "template-builder.js", "auto-walk.js");

const STORAGE_KEY = "backpack_captures";
const SESSION_KEY = "backpack_session"; // also read by core-content.js
const TEMPLATES_KEY = "backpack_templates"; // deliberately NOT cleared by CLEAR_CAPTURES
const REPLAY_KEY = "backpack_replay";
const CRAWL_PROGRESS_KEY = "backpack_crawl_progress"; // read directly by popup.js, same as the opt-in prefs
const MAX_CAPTURES = 500; // simple cap so storage.local never grows unbounded
const MAX_SESSION_PAGES = 300;
const IDLE_SESSION = {
  active: false,
  startedAt: null,
  count: 0,
  pages: [],
  // Always on - no longer a per-session choice (see START_SESSION below).
  followAssignmentLinks: true,
  crawlAllCourses: true,
  visitedDetailLinks: [],
  visitedCourseIds: [],
};
const PAGE_STEP_TIMEOUT_MS = 45000;
const PROMPT_STEP_TIMEOUT_MS = 180000;
// Long enough to cover content.js's own stuck-page recovery (its normal
// retry loop, then up to REFRESH_RELOAD_LIMIT full location.reload()s, each
// with its own settle/retry cycle after) without the crawl giving up and
// skipping a page that's still genuinely on its way to a good capture - a
// slower true skip beats a premature one.
const DETAIL_STEP_TIMEOUT_MS = 90000;
const COURSE_STEP_TIMEOUT_MS = 120000; // a Classwork page's own retry loop can take longer to settle than a details page
const MAX_DETAIL_LINKS_PER_VISIT = 20; // a class's full Classwork list can run to dozens of items
const MAX_COURSES_PER_CRAWL = 10; // a full course load can run well past this - keep one homepage crawl to a sane size
// This many non-ok captures in a row means something systemic (confirmed
// real: 14 straight pages all came back with Classroom's stuck-SPA banner
// across 17 minutes, likely Classroom throttling this session after
// several large automated walks in one day), not a per-page fluke -
// grinding through the rest of the queue would just produce more of the
// same, so the crawl stops itself instead.
const CIRCUIT_BREAKER_THRESHOLD = 3;
// A Classroom homepage/nav URL: /u/<n>/h, /u/<n>/h/st, ... but not the
// separate archived-classes listing (/u/<n>/h/archived) - that page's own
// course tiles are archived classes, which the crawl should never walk.
const HOME_URL_RE = /^https:\/\/classroom\.google\.com\/u\/\d+\/h(?:[/?#]|$)/;
function isHomeUrl(url) {
  return HOME_URL_RE.test(url) && !/\/h\/archived(?:[/?#]|$)/.test(url);
}

async function readKey(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] === undefined ? fallback : data[key];
}

async function getCaptures() {
  return readKey(STORAGE_KEY, []);
}

async function setCaptures(captures) {
  await chrome.storage.local.set({ [STORAGE_KEY]: captures });
}

async function getSession() {
  return { ...IDLE_SESSION, ...(await readKey(SESSION_KEY, {})) };
}

async function showSessionBadge(session) {
  await chrome.action.setBadgeText({ text: session.active ? "REC" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  await chrome.action.setTitle({
    title: session.active
      ? "Backpack Capture: capturing Google Classroom and Genesis pages"
      : "Backpack Capture: not capturing",
  });
}

async function saveSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  await showSessionBadge(session);
}

async function getTemplates() {
  return readKey(TEMPLATES_KEY, []);
}

async function setTemplates(templates) {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
}

async function setReplay(replay) {
  await chrome.storage.local.set({ [REPLAY_KEY]: replay });
}

// A session never survives a browser restart, so capture is never left
// running for days by someone who forgot to press End.
chrome.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  await saveSession({ ...session, active: false });
  await setReplay(null);
  await syncAutoWalkAlarm();
});

chrome.runtime.onInstalled.addListener(async () => {
  await showSessionBadge(await getSession());
  await syncAutoWalkAlarm();
});

// ---- replay -----------------------------------------------------------------

let runner = null; // { cancelled, tabId, onCapture, onStepDone }

function waitFor(assign, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      assign(null);
      resolve({ timedOut: true });
    }, timeoutMs);
    assign((value) => {
      clearTimeout(timer);
      assign(null);
      resolve(value || {});
    });
  });
}

async function runReplay(template) {
  const steps = template.steps || [];
  if (!steps.length) return;
  // MV3 service workers can be shut down while idle; a replay spends most of
  // its time waiting on page loads, so keep it awake until it's finished.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  let captured = 0;
  let skipped = 0;

  try {
    await saveSession({ active: true, startedAt: new Date().toISOString(), count: 0, pages: [], replaying: template.name });
    const tab = await chrome.tabs.create({ url: steps[0].url, active: true });
    runner = { cancelled: false, tabId: tab.id, onCapture: null, onStepDone: null };

    for (let i = 0; i < steps.length; i++) {
      if (runner.cancelled) break;
      const step = steps[i];
      await setReplay({
        active: true,
        name: template.name,
        templateId: template.id,
        index: i,
        total: steps.length,
        kind: step.kind,
        url: step.url,
      });

      if (step.kind === "page") {
        if (i > 0) await chrome.tabs.update(runner.tabId, { url: step.url });
        const result = await waitFor((fn) => {
          runner.onCapture = fn;
        }, PAGE_STEP_TIMEOUT_MS);
        if (result.timedOut) skipped++;
        else captured++;
      } else {
        try {
          await chrome.tabs.sendMessage(runner.tabId, { type: "SHOW_REPLAY_PROMPT", label: step.label });
        } catch (e) {
          // the tab has no content script (wrong page) - nothing to prompt on
        }
        const result = await waitFor((fn) => {
          runner.onStepDone = fn;
        }, PROMPT_STEP_TIMEOUT_MS);
        if (result.timedOut || result.skipped) skipped++;
        else captured++;
      }
    }

    const cancelled = runner.cancelled;
    const summary = cancelled
      ? "Backpack: replay stopped."
      : `Backpack: replay finished — ${captured} page${captured === 1 ? "" : "s"} captured${
          skipped ? `, ${skipped} skipped` : ""
        }. Open the extension to export.`;
    try {
      await chrome.tabs.sendMessage(runner.tabId, { type: "SHOW_REPLAY_TOAST", message: summary });
    } catch (e) {
      // tab closed mid-replay - the popup still shows the result
    }

    const templates = await getTemplates();
    await setTemplates(
      templates.map((t) =>
        t.id === template.id
          ? { ...t, lastReplayedAt: new Date().toISOString(), lastResult: { captured, skipped, cancelled } }
          : t
      )
    );
    await setReplay({ active: false, name: template.name, captured, skipped, cancelled });
  } finally {
    clearInterval(keepAlive);
    runner = null;
    const session = await getSession();
    await saveSession({ ...session, active: false, replaying: null });
  }
}

// ---- assignment-link crawl ---------------------------------------------------
//
// Opt-in (per session, off by default): when a captured Classroom page
// carries real links this is on for, the same tab is driven to each one in
// turn — same idea as replay, but scoped to one already-open tab and
// started automatically by a capture rather than a saved template. Each
// stop is captured by the normal STORE_CAPTURE path, so its content ends up
// alongside the rest of the session. The tab always returns to the page it
// started from.
//
// One engine, two ways in:
//  - a plain page's own assignment/material links (src/reducer.js
//    #extractDetailLinks) queue directly as "assignment"/"material" steps.
//  - the homepage's course links (#extractCourseLinks) queue as "course"
//    steps; landing on a course's Classwork page then splices whatever
//    assignment/material links THAT page carries in right after it, so the
//    whole course is finished before the crawl moves to the next one - a
//    breadth-first walk of courses, depth-first within each one.
const pageCrawls = new Map(); // tabId -> { queue, index, returnUrl, awaiting, timer, keepAlive, captured, skipped, coursesVisited, itemsCaptured, itemsSkipped, currentCourseTitle }

function clearCrawlTimers(crawl) {
  if (crawl.timer) clearTimeout(crawl.timer);
  if (crawl.keepAlive) clearInterval(crawl.keepAlive);
}

function crawlTally(crawl) {
  const pages = `${crawl.captured} page${crawl.captured === 1 ? "" : "s"}`;
  const courses = crawl.coursesVisited ? `${crawl.coursesVisited} class${crawl.coursesVisited === 1 ? "" : "es"}, ` : "";
  const skipped = crawl.skipped ? `, ${crawl.skipped} skipped` : "";
  return `captured ${courses}${pages}${skipped}`;
}

function crawlSummary(crawl) {
  return `Backpack: ${crawlTally(crawl)}.`;
}

// Read directly by popup.js (chrome.storage.local.get), the same way it
// already reads the opt-in checkbox prefs - no round-trip message needed
// for something this simple. Only one crawl's progress is tracked at a
// time even if, in principle, more than one tab could be crawling at
// once; a rare enough case that last-write-wins is an acceptable
// simplification rather than something worth a per-tab progress store.
// `itemsQueuedTotal` deliberately grows over the course of a course-walk
// crawl (each course's own items are only discovered once that course's
// Classwork page is actually visited), so it's a live "how much have we
// found so far," not a fixed target known from the start.
function saveCrawlProgress(crawl) {
  const itemSteps = crawl.queue.filter((s) => s.kind !== "course");
  const courseStepsSoFarInBatch = crawl.queue.slice(0, crawl.index + 1).filter((s) => s.kind === "course").length;
  const progress = {
    active: !crawl.finished,
    kind: crawl.queue.some((s) => s.kind === "course") ? "course" : "details",
    // Cumulative across the whole walk, not just this batch - see the
    // comment on totalKnownCourses/coursesVisitedBeforeBatch in startCrawl.
    courseIndex: crawl.coursesVisitedBeforeBatch + courseStepsSoFarInBatch,
    courseTotal: crawl.totalKnownCourses,
    currentCourseTitle: crawl.currentCourseTitle || null,
    itemsCaptured: crawl.itemsCaptured,
    itemsSkipped: crawl.itemsSkipped,
    itemsQueuedTotal: itemSteps.length,
    coursesVisited: crawl.coursesVisited,
    aborted: Boolean(crawl.aborted),
    updatedAt: new Date().toISOString(),
  };
  return chrome.storage.local.set({ [CRAWL_PROGRESS_KEY]: progress });
}

async function finishCrawl(tabId) {
  const crawl = pageCrawls.get(tabId);
  if (!crawl) return;
  clearCrawlTimers(crawl);
  pageCrawls.delete(tabId);
  crawl.finished = true;
  await saveCrawlProgress(crawl); // leaves the final tally visible until the next crawl starts
  try {
    await chrome.tabs.update(tabId, { url: crawl.returnUrl });
  } catch (e) {
    return; // tab is gone - nothing left to show a toast on
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SHOW_REPLAY_TOAST", message: crawlSummary(crawl) });
  } catch (e) {
    // no content script on the return page - nothing to show it on
  }
}

// Distinct from finishCrawl: this is the circuit breaker giving up early
// on purpose, not the queue running out normally, so it gets its own
// sticky toast explaining why, instead of the usual tally-only summary.
async function abortCrawl(tabId, reason) {
  const crawl = pageCrawls.get(tabId);
  if (!crawl) return;
  clearCrawlTimers(crawl);
  pageCrawls.delete(tabId);
  crawl.finished = true;
  crawl.aborted = true;
  // The homepage recapture this navigation triggers would otherwise start
  // the next batch; a scheduled run stops at the first sign of trouble.
  if (autoRun && autoRun.tabId === tabId) autoRun.aborted = reason;
  await saveCrawlProgress(crawl);
  try {
    await chrome.tabs.update(tabId, { url: crawl.returnUrl });
  } catch (e) {
    return; // tab is gone - nothing left to show a toast on
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_REPLAY_TOAST",
      message: `Backpack: stopped early - ${reason}. So far it ${crawlTally(crawl)}. Try again later.`,
      sticky: true,
    });
  } catch (e) {
    // no content script on the return page - nothing to show it on
  }
}

async function goToNextCrawlStep(tabId) {
  const crawl = pageCrawls.get(tabId);
  if (!crawl) return;
  const session = await getSession();
  if (!session.active || crawl.index >= crawl.queue.length) {
    await finishCrawl(tabId);
    return;
  }
  const step = crawl.queue[crawl.index];
  crawl.awaiting = step.href;
  if (step.kind === "course") crawl.currentCourseTitle = step.title || step.classId;
  await saveCrawlProgress(crawl);
  try {
    await chrome.tabs.update(tabId, { url: step.href });
  } catch (e) {
    await finishCrawl(tabId); // tab closed mid-crawl
    return;
  }
  clearTimeout(crawl.timer);
  const timeoutMs = step.kind === "course" ? COURSE_STEP_TIMEOUT_MS : DETAIL_STEP_TIMEOUT_MS;
  crawl.timer = setTimeout(() => advanceCrawlStep(tabId, { timedOut: true }), timeoutMs);
}

// Builds the (already deduped against what this session has visited)
// assignment/material steps for one course's worth of detail links, capped
// per course so one very full class can't turn a quick check into an
// open-ended crawl.
function detailStepsFrom(detailLinks, session, alreadyQueued) {
  const visited = new Set(session.visitedDetailLinks || []);
  const steps = [];
  for (const link of detailLinks || []) {
    if (visited.has(link.href) || alreadyQueued.has(link.href)) continue;
    alreadyQueued.add(link.href);
    steps.push({ kind: link.kind, href: link.href });
    if (steps.length >= MAX_DETAIL_LINKS_PER_VISIT) break;
  }
  return steps;
}

// Any STORE_CAPTURE from this tab while a step is in flight counts as that
// step's result - success or a login-wall/broken-shape capture alike - so a
// page that doesn't pan out still counts as "skipped", never blocks the
// crawl. `result` carries what that capture actually found, when it wasn't
// a timeout: {detailLinks, courseLinks} (only one is ever non-empty,
// depending on which kind of step just landed).
async function advanceCrawlStep(tabId, result) {
  const crawl = pageCrawls.get(tabId);
  if (!crawl) return;
  clearTimeout(crawl.timer);
  const step = crawl.queue[crawl.index];
  const timedOut = Boolean(result && result.timedOut);
  if (timedOut) crawl.skipped++;
  else crawl.captured++;

  // A step that never even timed out but still came back broken (a
  // login-wall/broken-shape capture, including the stuck-SPA state -
  // core-content.js only sends detailLinks/courseLinks for an "ok"
  // capture, so status here is the direct signal) counts the same as a
  // timeout for the circuit breaker: several of either in a row means
  // something systemic, not a fluke.
  const wasBad = timedOut || (result && result.envelope && result.envelope.status !== "ok");
  crawl.consecutiveBad = wasBad ? crawl.consecutiveBad + 1 : 0;
  if (crawl.consecutiveBad >= CIRCUIT_BREAKER_THRESHOLD) {
    await abortCrawl(tabId, `${crawl.consecutiveBad} pages in a row came back broken (Classroom may be throttling this session)`);
    return;
  }

  const session = await getSession();
  if (session.active) {
    if (step.kind === "course") {
      if (!timedOut) crawl.coursesVisited++;
      const visited = new Set(session.visitedCourseIds || []);
      visited.add(step.classId);
      await saveSession({ ...session, visitedCourseIds: [...visited] });
      // Splice this course's own assignment/material links in right after
      // it, so the whole course finishes before the crawl moves on to the
      // next one - depth-first within a course, breadth-first across them.
      if (!timedOut && result && result.detailLinks && result.detailLinks.length) {
        const alreadyQueued = new Set(crawl.queue.map((s) => s.href));
        const newSteps = detailStepsFrom(result.detailLinks, session, alreadyQueued);
        crawl.queue.splice(crawl.index + 1, 0, ...newSteps);
      }
    } else {
      if (timedOut) crawl.itemsSkipped++;
      else crawl.itemsCaptured++;
      const visited = new Set(session.visitedDetailLinks || []);
      visited.add(step.href);
      await saveSession({ ...session, visitedDetailLinks: [...visited] });
    }
  }

  crawl.index++;
  crawl.awaiting = null;
  await saveCrawlProgress(crawl);
  await goToNextCrawlStep(tabId);
}

// Returns whether a crawl actually started - the scheduled walk treats a
// homepage capture that starts nothing as "every class has been walked".
function startCrawl(tabId, returnUrl, queue, toastMessage, progressContext, sticky) {
  if (pageCrawls.has(tabId) || !queue.length) return false; // a crawl is already running in this tab
  pageCrawls.set(tabId, {
    queue,
    index: 0,
    captured: 0,
    skipped: 0,
    coursesVisited: 0,
    itemsCaptured: 0,
    itemsSkipped: 0,
    consecutiveBad: 0,
    currentCourseTitle: null,
    finished: false,
    // Filled in only for a course walk, so progress reporting can show a
    // cumulative "class N of <every active course>" across batches rather
    // than resetting to "class 1 of <this batch's size>" once a homepage
    // recapture starts a second batch for whatever's left over from the
    // first (see startCourseCrawl and saveCrawlProgress) - confirmed real
    // that without this, a walk that needed two batches looked like it had
    // reset partway through, when it had actually just moved on.
    totalKnownCourses: (progressContext && progressContext.totalKnownCourses) || 0,
    coursesVisitedBeforeBatch: (progressContext && progressContext.coursesVisitedBeforeBatch) || 0,
    returnUrl,
    awaiting: null,
    timer: null,
    keepAlive: null,
  });
  const crawl = pageCrawls.get(tabId);
  // MV3 service workers can be shut down while idle; a crawl spends most of
  // its time waiting on page loads, same as replay.
  crawl.keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  saveCrawlProgress(crawl);
  chrome.tabs.sendMessage(tabId, { type: "SHOW_REPLAY_TOAST", message: toastMessage, sticky: Boolean(sticky) }).catch(() => {
    // no content script yet on this tab - the navigation itself still proceeds
  });
  goToNextCrawlStep(tabId);
  return true;
}

function startDetailOnlyCrawl(tabId, session, returnUrl, detailLinks) {
  const queue = detailStepsFrom(detailLinks, session, new Set());
  if (!queue.length) return false;
  return startCrawl(
    tabId,
    returnUrl,
    queue,
    `Backpack: opening ${queue.length} assignment page${queue.length === 1 ? "" : "s"} to capture instructions…`
  );
}

function startCourseCrawl(tabId, session, returnUrl, courseLinks) {
  const visited = new Set(session.visitedCourseIds || []);
  const queue = [];
  for (const link of courseLinks) {
    if (visited.has(link.classId)) continue;
    queue.push({ kind: "course", href: link.classworkHref, classId: link.classId, title: link.title });
    if (queue.length >= MAX_COURSES_PER_CRAWL) break;
  }
  if (!queue.length) return false;
  // Sticky, and says so plainly: a real run's uniform, unrecovering string
  // of failures (see CIRCUIT_BREAKER_THRESHOLD above) looked exactly like
  // Classroom throttling at first, but the far simpler and likelier
  // explanation surfaced afterward was the laptop going to sleep mid-walk -
  // suspending every timer and dropping the network mid-navigation, which
  // Classroom's own SPA can surface as this same stuck-refresh state on
  // waking. A walk that never sleeps has nothing like this to recover from.
  return startCrawl(
    tabId,
    returnUrl,
    queue,
    `Backpack: walking ${queue.length} class${
      queue.length === 1 ? "" : "es"
    } to capture their Classwork and assignments… This can take a while - please keep this computer on and awake. If it sleeps or locks partway through, pages can get stuck and the walk may stop early.`,
    { totalKnownCourses: courseLinks.length, coursesVisitedBeforeBatch: visited.size },
    true
  );
}

// A crawling tab that's closed mid-flight would otherwise leak its timer
// and keep-alive interval forever.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (autoRun && autoRun.tabId === tabId) {
    autoRun.tabClosed = true;
    finishAutoWalk("cancelled", "the walk's window was closed");
  }
  const crawl = pageCrawls.get(tabId);
  if (!crawl) return;
  clearCrawlTimers(crawl);
  pageCrawls.delete(tabId);
  crawl.finished = true;
  saveCrawlProgress(crawl); // otherwise the popup would show a stuck "active" walk forever
});

// ---- publishing to schoolz ---------------------------------------------------
//
// Opt-in, off by default, and the one deliberate exception to this
// extension's standing "nothing is sent anywhere unless you export it"
// promise: a parent can choose to publish their local captures to their own
// family's schoolz account instead of (or alongside) a manual file export.
// Login is only ever a person pressing a button in the popup; publishing is
// too, unless that person also turned on the scheduled walk (below).
//
// schoolz's own web app authenticates the same way (Supabase email/password,
// same project) - this calls Supabase's auth REST API directly rather than
// bundling the supabase-js client, since a plain email+password grant and a
// refresh-token grant are the only two calls needed. SCHOOLZ_SUPABASE_URL
// and SCHOOLZ_SUPABASE_PUBLISHABLE_KEY are exactly what schoolz's own public
// frontend already ships embedded in its own JS bundle - a "publishable"
// key is meant for exactly this, the same way a Stripe publishable key is.
const SCHOOLZ_SUPABASE_URL = "https://lxithuvstfslndvsdnsk.supabase.co";
const SCHOOLZ_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ymxiIhkeaV6R5egNQI9gwA_iY95YXIR";
const SCHOOLZ_API_URL = "https://schoolz-api.sitenaut.com";
const SCHOOLZ_AUTH_KEY = "backpack_schoolz_auth"; // { access_token, refresh_token, expires_at, email }
const SCHOOLZ_TOKEN_REFRESH_SKEW_MS = 60000; // refresh a little before it actually expires, not after

async function getSchoolzAuth() {
  return readKey(SCHOOLZ_AUTH_KEY, null);
}

async function saveSchoolzAuth(auth) {
  await chrome.storage.local.set({ [SCHOOLZ_AUTH_KEY]: auth });
}

function schoolzAuthFromTokenResponse(json, email) {
  const expiresAt = json.expires_at ? json.expires_at * 1000 : Date.now() + (json.expires_in || 3600) * 1000;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: expiresAt,
    email,
  };
}

async function schoolzLogin(email, password) {
  const response = await fetch(`${SCHOOLZ_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SCHOOLZ_SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ email, password }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: json.error_description || json.msg || "Login failed" };
  }
  await saveSchoolzAuth(schoolzAuthFromTokenResponse(json, email));
  return { ok: true };
}

// Google sign-in, the way an extension does it: chrome.identity's own
// flow rather than a bundled Google/Supabase JS SDK. getRedirectURL()
// always returns https://<this extension's own id>.chromiumapp.org/ - the
// manifest's "key" field (see manifest.json) is what makes that id the
// same on every machine this is loaded unpacked on, rather than a
// different one per install path, since that exact URL has to be
// registered as an allowed redirect in schoolz's Supabase project ahead of
// time (Authentication -> URL Configuration -> Redirect URLs) for this to
// work at all - a one-time setup step on schoolz's side, not something
// this extension can do for itself.
async function schoolzLoginWithGoogle() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const authorizeUrl = `${SCHOOLZ_SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(
    redirectUrl
  )}`;

  let resultUrl;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl, interactive: true });
  } catch (e) {
    // The person closed the Google sign-in window, or it's not registered
    // as an allowed redirect yet - either way, nothing to recover from here.
    return { ok: false, error: "Google sign-in was cancelled or isn't set up yet" };
  }

  // Supabase's own implicit-grant callback puts the tokens in the URL
  // fragment, not a query string.
  const fragment = new URL(resultUrl).hash.replace(/^#/, "");
  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token");
  if (!accessToken) {
    return { ok: false, error: params.get("error_description") || "Google sign-in failed" };
  }

  const userResponse = await fetch(`${SCHOOLZ_SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SCHOOLZ_SUPABASE_PUBLISHABLE_KEY },
  });
  const userJson = await userResponse.json().catch(() => ({}));

  await saveSchoolzAuth({
    access_token: accessToken,
    refresh_token: params.get("refresh_token"),
    expires_at: Date.now() + (Number(params.get("expires_in")) || 3600) * 1000,
    email: userJson.email || "Google account",
  });
  return { ok: true };
}

async function schoolzLogout() {
  await chrome.storage.local.remove(SCHOOLZ_AUTH_KEY);
}

// Refreshes the access token when it's at or near expiry, so a login from
// hours or days ago (the refresh token itself lasts far longer) still works
// without asking the person to sign in again every time. Returns null (and
// clears the stored auth) if the refresh token itself has stopped working -
// the popup falls back to showing the login form again in that case.
async function ensureFreshSchoolzToken() {
  const auth = await getSchoolzAuth();
  if (!auth) return null;
  if (auth.expires_at - Date.now() > SCHOOLZ_TOKEN_REFRESH_SKEW_MS) return auth.access_token;

  const response = await fetch(`${SCHOOLZ_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SCHOOLZ_SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
  });
  if (!response.ok) {
    await schoolzLogout();
    return null;
  }
  const json = await response.json();
  const refreshed = schoolzAuthFromTokenResponse(json, auth.email);
  await saveSchoolzAuth(refreshed);
  return refreshed.access_token;
}

async function schoolzListStudents() {
  const token = await ensureFreshSchoolzToken();
  if (!token) return { ok: false, error: "not_logged_in" };
  const response = await fetch(`${SCHOOLZ_API_URL}/students`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { ok: false, error: `schoolz returned ${response.status}` };
  return { ok: true, students: await response.json() };
}

// Sends every capture currently stored, every time - schoolz's own import
// endpoint already dedupes by content hash per student (skips anything it's
// already stored), so resending is safe and simple rather than this
// extension having to track what it already published.
async function schoolzPublish(studentId, onlyCaptures) {
  const token = await ensureFreshSchoolzToken();
  if (!token) return { ok: false, error: "not_logged_in" };
  const captures = onlyCaptures || (await getCaptures());
  const response = await fetch(`${SCHOOLZ_API_URL}/students/${encodeURIComponent(studentId)}/bucket3/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ captures }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: json.detail || `schoolz returned ${response.status}` };
  return { ok: true, result: json };
}

// ---- scheduled walk ----------------------------------------------------------
//
// Off by default. Once a parent turns it on (popup, under Publish to
// schoolz), an hourly alarm checks whether a walk is due - every
// intervalHours, never in quiet hours - and if so opens the Classroom
// homepage in its own unfocused window, lets the normal course walk run
// exactly as it does when a person presses Start, publishes what's new to
// the chosen student, and closes the window.
//
// It never logs in. The Google session is one a person signed into by hand
// in this Chrome profile; when it lapses, the run stops at the sign-in page,
// records "needs_login", and tells schoolz so the parent gets a notification
// to come sign in again. DESIGN.md's "The scheduled walk" has the rationale.
const AUTO_WALK_ALARM = "backpack-auto-walk";
const AUTO_WALK_SETTINGS_KEY = "backpack_auto_walk";
const AUTO_WALK_LAST_KEY = "backpack_auto_walk_last"; // { startedAt, finishedAt, status, detail, published }
const AUTO_WALK_SEEN_KEY = "backpack_auto_walk_seen_details"; // { href: firstVisitedAtMs }
const AUTO_WALK_PUBLISHED_KEY = "backpack_auto_walk_published_through"; // latest captured_at already sent
// Long enough for Classroom's redirect chain and its own settle/retry loop
// on the homepage; a redirect off to Google's sign-in page never produces
// a capture at all, so this is also how that case is noticed.
const AUTO_WALK_HOME_TIMEOUT_MS = 3 * 60 * 1000;
const AUTO_WALK_MAX_MS = 90 * 60 * 1000;

let autoRun = null; // { tabId, windowId, startedAt, homeTimer, maxTimer, keepAlive, aborted, tabClosed }

async function syncAutoWalkAlarm() {
  const settings = BackpackAutoWalk.withDefaults(await readKey(AUTO_WALK_SETTINGS_KEY, null));
  if (!settings.enabled) {
    await chrome.alarms.clear(AUTO_WALK_ALARM);
    return;
  }
  // Hourly rather than every intervalHours: a machine that was asleep or
  // closed when a run came due picks it up within the hour instead of
  // waiting out a whole extra interval.
  const existing = await chrome.alarms.get(AUTO_WALK_ALARM);
  if (!existing) await chrome.alarms.create(AUTO_WALK_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_WALK_ALARM) startAutoWalk({ force: false });
});

async function startAutoWalk({ force }) {
  const settings = BackpackAutoWalk.withDefaults(await readKey(AUTO_WALK_SETTINGS_KEY, null));
  const lastRun = await readKey(AUTO_WALK_LAST_KEY, null);
  if (!force) {
    const reason = BackpackAutoWalk.skipReason(settings, new Date(), lastRun);
    if (reason) return { ok: false, error: reason };
  } else if (!settings.studentId) {
    return { ok: false, error: "no_student" };
  }
  // Never interrupt something a person started.
  if (autoRun) return { ok: false, error: "already_running" };
  if (runner || pageCrawls.size || (await getSession()).active) return { ok: false, error: "busy" };

  const startedAt = new Date().toISOString();
  if (!(await ensureFreshSchoolzToken())) {
    // Nowhere to publish to, and nowhere to report it except here.
    await chrome.storage.local.set({
      [AUTO_WALK_LAST_KEY]: { startedAt, finishedAt: startedAt, status: "schoolz_logged_out", detail: null, published: null },
    });
    return { ok: false, error: "schoolz_logged_out" };
  }

  const seen = BackpackAutoWalk.pruneSeenDetails(await readKey(AUTO_WALK_SEEN_KEY, {}), Date.now());
  await chrome.storage.local.set({ [AUTO_WALK_SEEN_KEY]: seen });
  await saveSession({
    ...IDLE_SESSION,
    active: true,
    startedAt,
    replaying: "scheduled walk",
    // Detail pages opened in the last day are skipped; every class's
    // Classwork list is still walked.
    visitedDetailLinks: Object.keys(seen),
  });
  await chrome.storage.local.set({ [AUTO_WALK_LAST_KEY]: { ...(lastRun || {}), startedAt, status: "running" } });

  let win;
  try {
    // Unfocused so it doesn't grab the keyboard from whoever is using the
    // machine, but a real on-screen window: Classroom lazy-loads as it
    // scrolls, and a minimized window doesn't render.
    win = await chrome.windows.create({
      url: BackpackAutoWalk.homeUrl(settings.accountIndex),
      focused: false,
      width: 1200,
      height: 900,
    });
  } catch (e) {
    await saveSession({ ...(await getSession()), active: false, replaying: null });
    await chrome.storage.local.set({
      [AUTO_WALK_LAST_KEY]: { startedAt, finishedAt: new Date().toISOString(), status: "error", detail: String(e), published: null },
    });
    return { ok: false, error: "window_failed" };
  }

  autoRun = {
    tabId: win.tabs[0].id,
    windowId: win.id,
    startedAt,
    studentId: settings.studentId,
    aborted: null,
    tabClosed: false,
    keepAlive: setInterval(() => chrome.runtime.getPlatformInfo(), 20000),
    homeTimer: setTimeout(() => noHomeCapture(), AUTO_WALK_HOME_TIMEOUT_MS),
    maxTimer: setTimeout(() => finishAutoWalk("timed_out", "the walk ran past 90 minutes"), AUTO_WALK_MAX_MS),
  };
  return { ok: true };
}

// No homepage capture at all. With no host permission for Google's sign-in
// page, its URL isn't even readable here - which is itself the tell: the
// tab left classroom.google.com.
async function noHomeCapture() {
  if (!autoRun || (await getSession()).count > 0) return;
  let url = null;
  try {
    url = (await chrome.tabs.get(autoRun.tabId)).url || null;
  } catch (e) {
    // tab is gone - onRemoved handles that
  }
  if (!url || !url.startsWith("https://classroom.google.com/")) finishAutoWalk("needs_login");
  else finishAutoWalk("broken", "the Classroom homepage never finished loading");
}

async function finishAutoWalk(status, detail) {
  const run = autoRun;
  if (!run) return;
  autoRun = null; // before any await, so nothing re-enters this run
  clearTimeout(run.homeTimer);
  clearTimeout(run.maxTimer);
  clearInterval(run.keepAlive);

  const crawl = pageCrawls.get(run.tabId);
  if (crawl) {
    clearCrawlTimers(crawl);
    pageCrawls.delete(run.tabId);
    crawl.finished = true;
    crawl.aborted = status !== "ok";
    await saveCrawlProgress(crawl);
  }

  const session = await getSession();
  await saveSession({ ...session, active: false, replaying: null });
  await chrome.storage.local.set({
    [AUTO_WALK_SEEN_KEY]: BackpackAutoWalk.mergeSeenDetails(
      await readKey(AUTO_WALK_SEEN_KEY, {}),
      session.visitedDetailLinks,
      Date.now()
    ),
  });
  if (!run.tabClosed) {
    try {
      await chrome.windows.remove(run.windowId);
    } catch (e) {
      // already closed
    }
  }

  // Publish whatever was captured, even from a run that stopped early -
  // those pages are real, and schoolz upserts rather than replaces.
  let published = null;
  const cutoff = await readKey(AUTO_WALK_PUBLISHED_KEY, null);
  const fresh = BackpackAutoWalk.capturesSince(await getCaptures(), cutoff);
  if (fresh.length) {
    const result = await schoolzPublish(run.studentId, fresh);
    published = result.ok
      ? { ok: true, processed: result.result.captures_processed, duplicates: result.result.captures_skipped_duplicate }
      : { ok: false, error: result.error };
    if (result.ok) {
      await chrome.storage.local.set({ [AUTO_WALK_PUBLISHED_KEY]: BackpackAutoWalk.latestCapturedAt(fresh) });
    }
  }

  await reportAutoWalkStatus(run.studentId, status, detail);
  await chrome.storage.local.set({
    [AUTO_WALK_LAST_KEY]: {
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      status,
      detail: detail || null,
      pages: session.count,
      published,
    },
  });
}

// Best effort: schoolz turns needs_login into a notification (and clears it
// again once a run succeeds). A failure here just leaves the popup's own
// last-run line as the only record.
async function reportAutoWalkStatus(studentId, status, detail) {
  try {
    const token = await ensureFreshSchoolzToken();
    if (!token) return;
    await fetch(`${SCHOOLZ_API_URL}/students/${encodeURIComponent(studentId)}/bucket3/capture-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, detail: detail || null }),
    });
  } catch (e) {
    // offline - nothing more to do
  }
}

// ---- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "STORE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      captures.unshift(message.envelope);
      if (captures.length > MAX_CAPTURES) captures.length = MAX_CAPTURES;
      await setCaptures(captures);

      const session = await getSession();
      if (session.active) {
        const pages = [...(session.pages || []), { url: message.envelope.source_url, at: message.envelope.captured_at }];
        if (pages.length > MAX_SESSION_PAGES) pages.splice(0, pages.length - MAX_SESSION_PAGES);
        await saveSession({ ...session, count: session.count + 1, pages });
      }
      if (runner && runner.onCapture && sender.tab && sender.tab.id === runner.tabId) runner.onCapture({});

      const tabId = sender.tab && sender.tab.id;
      sendResponse({ ok: true });

      // Fire-and-forget: the content script's own "captured this page" toast
      // shouldn't wait on whether a crawl starts or advances.
      if (tabId != null) {
        const crawl = pageCrawls.get(tabId);
        const isAutoTab = Boolean(autoRun && autoRun.tabId === tabId);
        if (crawl && crawl.awaiting) {
          advanceCrawlStep(tabId, {
            envelope: message.envelope,
            detailLinks: message.detailLinks,
            courseLinks: message.courseLinks,
          });
        } else if (isAutoTab && autoRun.aborted) {
          finishAutoWalk("aborted", autoRun.aborted);
        } else {
          let started = false;
          // During a scheduled run the session is on for every tab, but only
          // the run's own window should be driven - never a Classroom tab
          // someone happens to be reading at the same time.
          const mayCrawl = !autoRun || isAutoTab;
          if (mayCrawl && session.active && message.envelope.adapter === "classroom" && message.envelope.status === "ok") {
            // Always on (see START_SESSION) - following links and walking every
            // class from the homepage are no longer an opt-in choice, since
            // Export/Publish staying one-click, user-triggered actions already
            // guarantees the person sees and controls everything captured.
            if (isHomeUrl(message.envelope.source_url) && message.courseLinks && message.courseLinks.length) {
              started = startCourseCrawl(tabId, session, message.envelope.source_url, message.courseLinks);
            } else if (message.detailLinks && message.detailLinks.length) {
              started = startDetailOnlyCrawl(tabId, session, message.envelope.source_url, message.detailLinks);
            }
          }
          // The scheduled walk's tab only ever lands back on the homepage
          // between batches; one that starts nothing means every class is done.
          if (isAutoTab && !started) {
            if (message.envelope.status === "ok") finishAutoWalk("ok");
            else finishAutoWalk("broken", `the Classroom homepage came back "${message.envelope.status}"`);
          }
        }
      }
    })();
    return true;
  }

  // Sent by the content script instead of a capture when a Classroom page
  // turns out to be a sign-in screen (nothing is stored for those).
  if (message && message.type === "LOGIN_WALL") {
    if (autoRun && sender.tab && autoRun.tabId === sender.tab.id) finishAutoWalk("needs_login");
    sendResponse({ ok: true });
    return undefined;
  }

  if (message && message.type === "AUTO_WALK_GET") {
    (async () => {
      sendResponse({
        ok: true,
        settings: BackpackAutoWalk.withDefaults(await readKey(AUTO_WALK_SETTINGS_KEY, null)),
        lastRun: await readKey(AUTO_WALK_LAST_KEY, null),
        running: Boolean(autoRun),
      });
    })();
    return true;
  }

  if (message && message.type === "AUTO_WALK_SAVE") {
    (async () => {
      const current = BackpackAutoWalk.withDefaults(await readKey(AUTO_WALK_SETTINGS_KEY, null));
      const next = { ...current, ...message.settings };
      await chrome.storage.local.set({ [AUTO_WALK_SETTINGS_KEY]: next });
      await syncAutoWalkAlarm();
      sendResponse({ ok: true, settings: next });
    })();
    return true;
  }

  if (message && message.type === "AUTO_WALK_RUN_NOW") {
    (async () => {
      sendResponse(await startAutoWalk({ force: true }));
    })();
    return true;
  }

  if (message && message.type === "START_SESSION") {
    (async () => {
      const session = {
        active: true,
        startedAt: new Date().toISOString(),
        count: 0,
        pages: [],
        // Always on - no longer a choice the popup passes in. Following
        // links and walking every class are safe defaults precisely because
        // Export/Publish stay one-click, user-triggered actions - the
        // person always sees and controls exactly what was captured before
        // anything leaves the device.
        followAssignmentLinks: true,
        crawlAllCourses: true,
        visitedDetailLinks: [],
        visitedCourseIds: [],
      };
      await saveSession(session);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message && message.type === "END_SESSION") {
    (async () => {
      const session = { ...(await getSession()), active: false };
      await saveSession(session);
      // Don't leave a tab sitting mid-crawl for up to its step timeout
      // waiting to notice the session ended.
      for (const tabId of [...pageCrawls.keys()]) finishCrawl(tabId);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message && message.type === "GET_SESSION") {
    (async () => {
      sendResponse({ ok: true, session: await getSession() });
    })();
    return true;
  }

  if (message && message.type === "SAVE_TEMPLATE") {
    (async () => {
      const session = await getSession();
      const steps = self.BackpackTemplates.buildSteps(session.pages);
      if (!steps.length) {
        sendResponse({ ok: false, error: "no_pages" });
        return;
      }
      const template = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: (message.name || "").trim() || self.BackpackTemplates.defaultName(new Date()),
        createdAt: new Date().toISOString(),
        steps,
        lastReplayedAt: null,
        lastResult: null,
      };
      await setTemplates([template, ...(await getTemplates())]);
      sendResponse({ ok: true, template });
    })();
    return true;
  }

  if (message && message.type === "GET_TEMPLATES") {
    (async () => {
      sendResponse({ ok: true, templates: await getTemplates(), replay: await readKey(REPLAY_KEY, null) });
    })();
    return true;
  }

  if (message && message.type === "DELETE_TEMPLATE") {
    (async () => {
      await setTemplates((await getTemplates()).filter((t) => t.id !== message.id));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "START_REPLAY") {
    (async () => {
      if (runner) {
        sendResponse({ ok: false, error: "already_replaying" });
        return;
      }
      const template = (await getTemplates()).find((t) => t.id === message.id);
      if (!template) {
        sendResponse({ ok: false, error: "not_found" });
        return;
      }
      runReplay(template); // deliberately not awaited - it outlives this message
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "CANCEL_REPLAY") {
    (async () => {
      if (runner) {
        runner.cancelled = true;
        if (runner.onCapture) runner.onCapture({});
        else if (runner.onStepDone) runner.onStepDone({ skipped: true });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "REPLAY_STEP_DONE") {
    (async () => {
      if (runner && runner.onStepDone) runner.onStepDone({ skipped: Boolean(message.skipped) });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "DELETE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      await setCaptures(captures.filter((c) => c.id !== message.id));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "CLEAR_CAPTURES") {
    (async () => {
      await setCaptures([]); // saved templates are kept - each has its own X
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "GET_CAPTURES") {
    (async () => {
      sendResponse({ ok: true, captures: await getCaptures() });
    })();
    return true;
  }

  if (message && message.type === "EXPORT_CAPTURES") {
    (async () => {
      const captures = await getCaptures();
      const payload = JSON.stringify({ exported_at: new Date().toISOString(), captures }, null, 2);
      const url = `data:application/json;base64,${btoa(unescape(encodeURIComponent(payload)))}`;
      // Include time, not just date - re-exporting later the same day
      // previously overwrote the earlier file (with saveAs, only if the
      // user keeps the suggested name), losing whatever the earlier
      // export had already captured for diagnosis.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `backpack-captures-${stamp}.json`;
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ ok: true, downloadId });
    })();
    return true;
  }

  if (message && message.type === "TRIGGER_MANUAL_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !self.BackpackSites.supportedSite(tab.url)) {
        sendResponse({ ok: false, error: "unsupported_tab" });
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_CAPTURE" });
        sendResponse(result || { ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message && message.type === "SCHOOLZ_GET_STATE") {
    (async () => {
      const auth = await getSchoolzAuth();
      if (!auth) {
        sendResponse({ ok: true, loggedIn: false });
        return;
      }
      const students = await schoolzListStudents();
      if (!students.ok) {
        // The stored login no longer works (e.g. the refresh token expired
        // days later) - report logged-out rather than showing a student
        // picker that can't actually publish anything.
        sendResponse({ ok: true, loggedIn: false });
        return;
      }
      sendResponse({ ok: true, loggedIn: true, email: auth.email, students: students.students });
    })();
    return true;
  }

  if (message && message.type === "SCHOOLZ_LOGIN") {
    (async () => {
      sendResponse(await schoolzLogin(message.email, message.password));
    })();
    return true;
  }

  if (message && message.type === "SCHOOLZ_LOGIN_GOOGLE") {
    (async () => {
      sendResponse(await schoolzLoginWithGoogle());
    })();
    return true;
  }

  if (message && message.type === "SCHOOLZ_LOGOUT") {
    (async () => {
      await schoolzLogout();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "SCHOOLZ_PUBLISH") {
    (async () => {
      sendResponse(await schoolzPublish(message.studentId));
    })();
    return true;
  }

  return undefined;
});
