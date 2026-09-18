# Design notes

This extension implements "Tier 1" of a larger design for reading a child's
school-portal data (Google Classroom, Genesis, and similar) without ever
automating a login. The reasoning below is adapted from the original design
notes; personal details have been generalized since this repo is public.

## The problem

A child's Google Classroom account is usually a district-managed Google
Workspace for Education identity, not a personal account. Two obvious
approaches to reading it programmatically don't work:

- **OAuth against the Classroom API.** The district, as the Workspace
  admin, controls which third-party OAuth clients may request
  `classroom.*` scopes against student accounts at all. A personal/
  unapproved app has no path to get that consent.
- **Scripted/headless login.** Automating a sign-in (Playwright, a login
  script, etc.) runs straight into Google's bot/automation detection and
  the account's own MFA/session policies. A district-managed student
  identity is a high-scrutiny target for this.

Genesis (and similar portals) have no public API at all, so the same
scripted-login problem applies there too.

Both failure modes share a root cause: anything that presents credentials
or simulates a login *as* automation is exactly what these systems are
built to detect and block.

## What works: read the DOM of a session the human already opened

1. A parent (or the student) logs into Classroom **normally**, in their own
   Chrome, as themselves — no automation touches the login at all.
2. Once that page is open and fully rendered, something reads back the
   *rendered* DOM — not a raw HTTP fetch of the URL, but the same content
   the human is looking at, including everything the client-side JS painted
   in after login.
3. That content is reduced to the parts that actually carry signal
   (assignment titles, due dates, links) and the rest is thrown away.

**Why this sidesteps both failed approaches**: nothing here ever
authenticates *as* an automated agent. The human's own already-authorized
browser session does 100% of the authentication and rendering; this
extension's job is only to read back the resulting page content. There's no
OAuth consent to obtain, no login to script, and no bot-detection surface to
trip, because from Google's point of view this is indistinguishable from a
person reading their own account in their own browser — because it is one.

## Design principles

1. **The human authenticates; the extension only reads.** It never logs in,
   never submits a form, never touches an auth flow.
2. **Never read credentials.** Not cookies, not tokens, not `localStorage`,
   not the password manager. The capture surface is the rendered DOM and
   nothing else — the declared permissions in `manifest.json` are meant to
   make this readable at a glance (no `cookies`, no `webRequest`, no
   `<all_urls>`).
3. **Local-first, no server.** This is a child's education record. It stays
   on the machine it was captured on until the person exports it themselves.
4. **Never store a login page as if it were data.** A capture that lands on
   a sign-in redirect looks structurally valid and contains zero real
   content — it's detected explicitly (URL + heuristics) and refused rather
   than silently overwriting a good capture with nothing.

## Why a browser extension, and not something else

- **Extension inside a school-managed Chrome profile.** Often dead on
  arrival — a webpage can't block an extension, but a district's Chrome
  policy (`ExtensionInstallBlocklist`/`ExtensionSettings`) can, and that
  policy attaches to whichever profile is signed into *the browser* with
  the managed account. Developer-mode loading is normally caught by the
  same policy. If this applies to your situation, a separate, dedicated
  Chrome profile that is never signed into as a browser — with the
  Classroom/Genesis account logged in only as a website session inside it —
  is the documented workaround; see the original design notes' verification
  protocol for how to check whether that holds for a given district.
- **A CDP-driven "capture window."** Works, but is strictly more machinery
  than a normal content script for the same result, and has no visible
  "captured" affordance for the parent to see happening.
- **An embedded browser (e.g. inside an Electron app).** Google actively
  blocks sign-in from embedded/webview contexts, and a district-managed
  Workspace account is exactly the population that block targets hardest.
  The person would never get logged in at all.
- **Loopback HTTP instead of just local storage.** Simpler in some ways, but
  opens a port any local process can reach. This repo has no server-shaped
  surface at all — just local extension storage and a manual export.

## Settle detection

Classroom paints progressively and lazy-loads as you scroll. Capturing on
`load` gets a skeleton. The content script runs a `MutationObserver`
quiet-period check and captures once the page has been still for ~750ms,
with a hard ceiling (~10s) so a permanently-spinning widget still yields
something. The initial load-triggered capture also scrolls toward the
bottom first, since Classroom defers content until it scrolls into view —
a capture that never scrolled would quietly miss older stream items.

## Reduction — the part that matters most

**Never ship raw HTML.** A real captured Classroom page is on the order of
1.8MB, almost all of it obfuscated class-name soup, inline base64, and
framework noise. The reducer strips `<script>`, `<style>`, `<svg>`,
`<noscript>`, comments, and every `data:` URI and class attribute — in
testing, this took a real 1.8MB capture down to about 80KB of actual
content.

**The non-obvious part: keep the accessibility attributes.** In real
Classroom markup, `aria-label` carries the entire semantic payload that the
visible text does not:

```
aria-label="Assignment: Quiz: The Americas and Europe Before 1492, due Tomorrow"
```

A generic HTML-to-text/readability pass throws those away — and the due
dates go with them. The reducer preserves `aria-label`, `role`, `title`,
`href`, `datetime`, and `data-*` on every retained node, and anchors its
"is this really an assignment page" check on `aria-label` patterns, never on
Google's CSS class names — those are generated and churn between deploys.

## Capture envelope

Every capture carries, alongside the reduced text:

| Field | Why |
|---|---|
| `captured_at` (absolute, ISO 8601) | relative dates like "due Tomorrow" are meaningless without an anchor |
| `timezone` | needed to resolve relative dates correctly later |
| `source_url` | which class/view this came from |
| `account_index` (`/u/0/`, `/u/1/`) | which Google account — important the moment more than one child shares a machine |
| `adapter` + `adapter_version` | so a future reducer change can trigger re-extraction of old captures |
| `char_count` | feeds the low-confidence check |

## What's deliberately out of scope here

- **Automated login, and unattended refresh.** Non-negotiable — it's what
  makes the whole approach work at all. A capture happens because a person
  is looking at the page, never on a timer with nobody present.
- **Turning work in, messaging teachers, or any write action.** Read-only.
- **Due-date/assignment extraction, dedup, and a consolidated UI.** This
  repo produces reduced JSON; turning that into a "what's due" list is a
  separate follow-on project.
- **Other portals** (ClassDojo, Remind, ...). The same technique should
  generalize, but each is its own adapter with its own DOM shape to verify
  against a real capture first — same as Genesis was.

## Genesis: confirmed shape (differs from the original assumption)

The original notes this design is adapted from assumed Genesis would be a
legacy frames-and-tables layout needing `all_frames: true`. A real capture
of a Genesis Parent Portal "student summary" page (Cherry Hill Public
Schools' instance, `parents.<district>/genesis/parents`) showed otherwise:

- **No frames at all** — it's a single modern document. `all_frames` isn't
  needed.
- **No semantic attributes on the payload.** Unlike Classroom's
  `aria-label`, Genesis's schedule cards carry no `aria-label`/`role`/
  anything — the class name, term, teacher, room, period, and days are
  plain nested `<div>` text with only inline styles for card coloring:
  ```html
  <div>GEOMETRY A</div><div><b>FY</b></div>
  <div><i>Borrelli/Squazzo</i></div>
  <div>Room <b>C203</b></div>
  <div>Period <b>A</b></div>
  <div>Days <b>123456</b></div>
  ```
  So the Genesis reducer keeps plain text runs in document order instead of
  hunting for attributes — the generic strip-and-flatten primitive
  (`src/core-reduce.js`) already does this; only the expected-shape check
  (a `Period <letter>` marker) and login-wall/student-id logic are
  Genesis-specific (`src/genesis-reducer.js`).
- **Student identity is a `studentid` query parameter**
  (`?tab1=studentdata&tab2=studentsummary&studentid=1234567`), not a
  `/u/<n>/` path segment like Classroom.
- **The host varies per district** — every Genesis deployment uses the same
  `/genesis/parents` path on its own subdomain, so the extension's host
  permission matches on path (`*://*/genesis/parents*`) rather than one
  hardcoded domain.
- Real reduction result: a ~168KB saved page reduced to ~8KB of actual
  schedule text, all fields (class/term/teacher/room/period/days) intact
  and in the right grouping.

This is exactly the kind of assumption the design doc's own "verify one
real capture first" rule exists to catch — building the frames-based
adapter first would have produced nothing.

**Update, same day**: a second real capture (from an actual live session,
not the saved-page fixture) revealed the student-summary page actually has
*two* schedule renderings, switchable in place without a page reload:

- **List View** (described above) — full-year schedule, explicit
  `Period <letter>` text, no clock times.
- **Daily View** — today's schedule only, period letters as bare headers
  followed by a time range and `Room: <room> <term>` on one line (e.g.
  `A` / `7:30 AM - 8:27 AM` / `GEOMETRY A` / `Borrelli/Squazzo` /
  `Room: C203 FY`), no literal word "Period" anywhere. This is the view a
  session lands on by default.

The expected-shape check (`checkGenesisShape`) was originally written
against List View only and wrongly flagged real Daily View captures as
`adapter_may_be_broken` — fixed by checking for `Room` (present in both)
rather than the List-View-only `Period <letter>` text.

**Also confirmed real from that same live capture**: the schedule content
loads via a separate AJAX call *after* the page shell settles, and can
still show Genesis's own `"One moment..."` placeholder when the
MutationObserver's quiet-period fires — `core-content.js`'s
`retryOnBadShape` option (re-settle and re-check up to N times) exists
specifically for this. And the page also embeds a Google Translate widget
(`#google_translate_element`) whose language dropdown made up ~70% of a
real capture's reduced text despite zero schedule content — excluded via
`core-reduce.js`'s `skipSelectors` option.

Since List View and Daily View carry complementary data (List View: which
class each period is assigned, for the whole year; Daily View: today's
actual clock times) and toggling between them doesn't navigate or scroll
the page, a plain click-based recapture trigger was added
(`core-content.js`, mirroring the existing scroll-based one) so switching
views captures both instead of only whichever one a page load or scroll
happened to catch.

## Classroom: capturing mid-navigation (fixed in 0.2.4)

Classroom switches classes without a page load and keeps the previously
opened class's view in the DOM. Confirmed real on every Classwork capture
in a full export: the capture under Geometry's URL held Geometry's own
(fully loaded) views *and* English's view - the class opened just before -
so a consumer attributing rows by URL filed each class's work under the
class opened after it.

Each rendered class page is a view whose root names its class:
`data-p='%.@."<class id>"]'`, the same base64-of-a-number id the URL uses.
`reducer.js` leaves out views naming a different class than the URL
(`otherClassViews` → `core-reduce.js`'s `skipElements`), and reports
`viewReady` - a view for the URL's class exists. `core-content.js`'s `retry`
loop waits on it, and a page that never becomes ready is **not stored**: a
capture labeled with the wrong class is worse than none. Pages with no
class in the URL (home, to-do) or no class view roots keep everything and
never block. Because Classroom never reloads, the runner also polls
`location.href` and recaptures after a URL change.

## Templates and replay (added in 0.4.0)

Capturing is a repeated chore: the same handful of Classwork pages plus the
same Genesis tabs, every week. A **template** is one finished session's page
list, saved so it can be walked again later (`src/template-builder.js`,
`buildSteps`), and **replay** drives one new tab through those addresses
while a session is running, so each page is captured by the normal path.

Why addresses and not recorded clicks: every page that carries real content
is URL-addressable (confirmed across a full real export - each class's
Classwork, each Genesis tab), while click replay would have to anchor on
Google's generated markup, which this codebase deliberately never depends
on. Replaying URLs also degrades honestly - a step that captures nothing is
reported as skipped, rather than a click silently landing on the wrong
element.

The one thing a URL can't express is Genesis's List View / Daily View
toggle, which swaps content in place on the same URL. A session that
captured one Genesis page more than once is exactly what toggling looks
like, so `buildSteps` follows that page with a `kind: "prompt"` step:
replay shows a sticky toast asking the person to switch the view and press
**Done** (or **Skip**). This keeps the extension's standing promise that it
never clicks or automates anything on the site's side - and it's visible, so
nobody is left wondering why a replay is sitting still.

Replay state (`backpack_replay`) and templates (`backpack_templates`) are
their own storage keys: **Clear all** empties captures only, and each
template has its own delete. MV3 service workers are shut down when idle and
a replay spends its time waiting on page loads, so `runReplay` holds a
keep-alive interval until it finishes.

## Following assignment/material links, and walking every class (added in 0.5.0)

A class's Classwork/Stream list only gives a title and due date; the actual
instructions - what the assignment is asking for, what "done" looks like -
live on the item's own details page (confirmed real: a physical-worksheet
assignment where the printed page alone was ambiguous, and the Classroom
details page cleared it up). Capturing that too, without a person having to
open every item by hand, is what this feature does - as two opt-in,
off-by-default levels: follow the links on whatever page you're on, or (from
the homepage specifically) walk every active class first.

**Why extraction, not reconstruction.** `src/reducer.js#extractDetailLinks`
walks the already-reduced tree for nodes with a real `href` resolving to
`/c/<classId>/(a|m)/<itemId>/details`, and only those - never one
reconstructed from `data-stream-item-id` or any other internal id. A real
capture examined while building this showed the same work item rendered two
different ways depending on where it appears: as an actual anchor with a
real `href` (e.g. an upcoming-due widget), or, for the general
Classwork/Stream list, as a JS-driven `role="link"` element with no `href`
at all. Reconstructing a details URL from that id plus the page's own class
id would depend on Google's internal attribute conventions in exactly the
way `otherClassViews` and `classIdFromUrl` above already refuse to for
detecting view state - and getting it wrong here isn't "captures nothing,"
it's "captures the wrong assignment's instructions under the wrong page's
address." So an item with no real anchor is left out, degrading honestly the
same way a `viewReady: false` page or a timed-out replay step does. Which
`aria-label` wording is present decides only the cosmetic title/due shown in
a toast, never whether the link is followed - `kind` (assignment vs.
material) is read off the href's own `/a/`-vs-`/m/` segment instead, since a
details page reached from a different rendering could plausibly carry a
label that doesn't match the "Assignment:"/"Material:" convention at all -
unconfirmed for any real capture in hand, but cheap to guard against, so the
code doesn't require it. A fixture covers both the confirmed-real shape and
this defensive one (`test/fixtures/classroom-detail-links.html`). *Revisited
in 0.6.0 below* - "no real anchor" turned out to be the norm for Classwork
specifically, not the exception.

**Reconstructing a details link when no real anchor exists (added in
0.6.0).** A full account walk (0.5.1) turned up something the sample used to
build extractDetailLinks didn't show: on every single Classwork-tab capture
examined, every work item rendered as a JS-driven `role="button"` with no
`href` at all - title, due date, and type ("Assignment"/"Material") all
present as plain text and attributes, just no real link anywhere.
Extraction alone left the whole feature unable to do the one thing it was
built for when driven from Classwork.

`src/reducer.js#reconstructWorkItemLinks` fills that gap, but only for an
item extraction found no real link for (a real anchor always wins). It
locates each item by its `data-stream-item-id` and builds
`/u/<n>/c/<classId>/(a|m)/<streamItemId as base64url>/details` directly -
the one other deliberate exception to "never reconstruct" in this file,
alongside `classworkHrefFor`. What makes it defensible this time, unlike
the case argued against above: the encoding isn't a guess about Google's
conventions, it's verified exact - a real details URL's own item-id
segment, base64-decoded, produced the identical numeric string as the
`data-stream-item-id` sitting next to that exact assignment's title. `kind`
comes from a literal, visible "Assignment"/"Material" text node in the
item's own markup (never the `aria-label`, whose wording is unconfirmed
here), and the "Assignment options for ..."/"Material options for ..."
tooltip-trigger label sitting in the same subtree is explicitly excluded so
it's never mistaken for the item's own title.

The weaker link is the class id: a real anchor's `href` always names its
own class regardless of which page it's found on, but a reconstructed link
instead trusts that the item truly belongs to the page it was captured on -
exactly the assumption the Classwork stale-view leak noted above (a
capture with a few other classes' leftover items) has already shown can be
wrong. So reconstruction only runs when `otherClassViews` reports `ready`
for the page as a whole; it's a coarser guard than per-item verification
would be, since that same leak proved items can slip through without
tripping it, but it's the best signal already available without inventing
a new one, and it never overrides whatever extraction already found.

**Why Classwork, not Stream, for finding a class's assignments.**
`src/reducer.js#extractCourseLinks` finds a class's own link the same way -
a real `role="menuitem"` anchor to a bare `/c/<classId>`, present both in
the persistent class-switcher nav and the homepage's own course tiles
(confirmed real against a homepage capture). Landing on a course from there
goes to its Classwork page (`/w/<classId>/t/all`), not its Stream, on
purpose: Google's own Classroom help documents Stream as "the class message
board" while Classwork is where "assignments, questions, and quiz
assignments" actually live, organized by topic with status and time-period
filters - and Classroom's own user community has reported Stream capping
out at a handful of recent posts, which would make it an unreliable source
for "every assignment in this class." A real Classwork-tab capture examined
while building this confirmed items there carry the same `href` +
`aria-label` due-date shape Stream's widget items do.

That same real capture also turned up a separate, pre-existing bug worth
noting here: a Classwork page captured right after browsing other classes
still had four other classes' assignments mixed into its own reduced text -
stale DOM `otherClassViews` doesn't catch, because whatever leftover
element it's in doesn't carry the `[data-p]` wrapper that function looks
for. It doesn't corrupt this feature (a link's own `href` always names its
real class, never the page it was found on), but the capture's stored text
for that page is noisier than it should be - a fix belongs in
`otherClassViews`, not here.

**Why a background-driven crawl, not clicking.** Once the links are known,
following them re-uses the same address-based approach as replay: the
background worker (`src/background.js`'s `pageCrawls` engine) drives the
*same* tab to each one with `chrome.tabs.update`, waits for that page's own
normal capture to land (any `STORE_CAPTURE` from that tab while a step is in
flight counts as the result - a login-wall or broken-shape capture included,
so a page that doesn't pan out still degrades to "skipped," never blocks),
then returns the tab to the page it started from. This is deliberately a
bigger behavior change than passive capture (the tab visibly navigates away
and back on its own), which is why each level is gated behind its own
checkbox in the popup rather than being what **Start capture** always does,
and why a toast announces it before it happens.

**One engine, two ways in.** `pageCrawls` is a flat, ordered queue of
typed steps (`{kind: "assignment"|"material"|"course", href, ...}`), keyed
by tab id so more than one tab can run its own crawl. A plain page's own
detail links queue directly. A homepage capture's course links queue as
`"course"` steps instead; landing on one and capturing its Classwork page
splices *that* page's own detail links in right after it
(`crawl.queue.splice(crawl.index + 1, 0, ...newSteps)`) - so the whole
course finishes (depth-first) before the crawl moves to the next course
(breadth-first across them), and the final "next" is always either the next
course or, once every course is done, the original homepage. Home is
recognized narrowly (`HOME_URL_RE` / `isHomeUrl`) to explicitly exclude the
separate archived-classes page, so "every course this finds" is naturally
"every *active* course" - archived classes never appear in the normal course
list at all, so no separate active/archived filtering is needed.

**Bounds.** `MAX_DETAIL_LINKS_PER_VISIT` (20) caps how many assignment/
material links one course - or one plain page visit - queues at once, and
`MAX_COURSES_PER_CRAWL` (10) caps how many courses *one* crawl walks before
returning to the homepage - not the whole account. Every visited link and
every visited class id is added to the session's `visitedDetailLinks`/
`visitedCourseIds`, so recapturing the same page later in the same session
(scroll-settle, click-settle, a revisit) never re-queues it. Confirmed real
on a full account with more than 10 active courses: returning to the
homepage after one 10-course batch triggers the homepage's own normal
recapture, which starts a second batch for whatever courses aren't in
`visitedCourseIds` yet - so a large account gets walked in successive
capped batches rather than being stopped at 10 forever, and the walk is
over once a homepage recapture finds nothing left to queue. Ending the
session mid-crawl (`END_SESSION`) tears down any in-flight crawl
immediately rather than waiting out its per-step timeout, and a course step
gets a longer timeout (`COURSE_STEP_TIMEOUT_MS`, 60s) than a detail step
(`DETAIL_STEP_TIMEOUT_MS`, 45s) since a Classwork page's own settle/retry
loop can take longer - both sized generously enough to also cover the
stuck-page recovery described next, on the theory that a slower true skip
beats a premature one.

## Recovering from Classroom's own stuck-SPA state (added in 0.6.1)

A full account walk (backpack-captures-2026-09-18T00-20-13.json, 165 pages
in one run) turned up something none of the smaller runs had: one
reconstructed details page came back with almost no content and a literal
"Refresh your browser to update this page" banner, a stuck 0%-progress
loading bar, and Classroom's own persistent "Page is loading…" status
element still present. Checking the page's own `data-p` attribute showed
the constructed address was exactly right - this wasn't a bad link, Google's
own app had gotten stuck mid-navigation, almost certainly from the crawl
driving it through far more page-to-page transitions per minute than a
person browsing normally ever would.

`src/reducer.js#looksStuckNeedingRefresh` looks for that exact banner text
and surfaces it as `needsRefresh`, which `core-content.js`'s existing
Classroom retry loop (see `notReady` in `createCaptureRunner`) now treats
the same way it already treats a stale class view: keep retrying in place
for a few seconds first. The difference is what happens if that still
doesn't clear it - unlike an ordinary slow load, this state doesn't seem to
resolve just by waiting, so the page forces a real `location.reload()`
(exactly what the banner itself says to do) and lets the fresh load capture
it from scratch.

**One reload wasn't always enough.** A follow-up run
(backpack-captures-2026-09-18T13-38-48.json, steps spaced a deliberate ~30s
apart - so this isn't purely a "too fast" problem) showed two separate
Classwork-tab pages still carrying the identical banner *after* their one
reload attempt each. `REFRESH_RELOAD_LIMIT` (2) now allows a second try
per page, tracked in `sessionStorage` (keyed by `location.pathname`, a
count rather than a flag) so a page that's genuinely broken for good still
stops retrying and falls through to a normal capture attempt, labeled
`adapter_may_be_broken` like any other capture that didn't pan out.
`REFRESH_RELOAD_DELAY_MS` (2s) pauses briefly before each reload, on the
theory that reloading instantly risks landing right back in whatever race
caused it in the first place. `DETAIL_STEP_TIMEOUT_MS`/
`COURSE_STEP_TIMEOUT_MS` (background.js) were widened again (90s/120s) to
comfortably cover two full reload cycles rather than skipping a page
mid-recovery.

## Filtering out items from before this school year (added in 0.7.0)

A real "Class of 2029" capture (a student-government-style class that
never gets archived, so it accumulates posts across multiple school
years) turned up dozens of items from 2025 and from May 2026 - the
previous school year - mixed in with current ones. Walking those every
time is pure wasted time, and the request was explicit: only bring in
items from this school year.

**Why "nearest occurrence," not a fixed year.** Classroom never shows a
year on either a due date or a "Created" date - confirmed real for both:
`Due May 11, 7:30 AM` and `Created` / `May 8` (two separate, adjacent text
nodes) are exactly what a real capture showed for the same May 2026 item.
A bare "May 11" seen from September is genuinely ambiguous on its own - it
could mean the May that already happened or the one 8 months from now -
and there's no exact school-year-start date available from either
Classroom or Genesis to resolve it against directly. `resolveNearestDate`
resolves it the standard way a bare recurring date gets disambiguated:
whichever of last year's, this year's, or next year's occurrence of that
month/day is fewest calendar days from now. This happens to fall on the
correct side of a school-year boundary without needing to know the exact
boundary at all - a date a few months in the past resolves to the past, one
a few months out resolves to the future, and either interpretation is only
ever compared against a generic `schoolYearStart` (August 1) to decide
in/out of scope.

**Where it applies.** `isRecentEnough` (in `reduce()`) filters the combined
`detailLinks` - real anchors and reconstructed links alike - using each
item's own `due` date, falling back to `created` only when there's no due
date at all (true for materials and announcement-style posts, which is
most of what a class like this one carries). An item with neither is kept,
never filtered for lack of information, the same conservative default used
throughout this file. This only changes what the crawl chooses to *visit*
- it doesn't touch what's already in a captured page's own reduced text.

## Live progress while a walk runs (added in 0.7.0)

A course-walk crawl can run for many minutes across dozens of classes and
hundreds of items with no visible indication of how far along it is beyond
watching the tab navigate. `background.js`'s `saveCrawlProgress` writes a
live snapshot to `backpack_crawl_progress` (`chrome.storage.local`) on
every step - which class it's on out of how many, and how many items have
been captured in total - and `popup.js` reads it directly (the same way it
already reads the opt-in checkbox prefs, no round-trip message needed) and
renders two `<progress>` bars, refreshed live via `chrome.storage.onChanged`
the same way captures, session state, and replay progress already are.

The item total is deliberately a moving target, not a fixed one: a
course's own items are only discovered once its Classwork page is actually
visited (see "One engine, two ways in" above), so `itemsQueuedTotal` grows
over the course of a walk rather than being knowable up front. Only one
crawl's progress is tracked at a time - a rare concurrent-tab case would
mean last-write-wins, an acceptable simplification rather than a per-tab
progress store for something this cosmetic. The final tally stays visible
after a walk finishes (or the tab is closed mid-walk) until the next one
starts and resets it, the same way replay's own finished state persists.

## Stopping early when Classroom itself seems to be pushing back (added in 0.7.1)

A real walk (backpack-captures-2026-09-18T14-53-46.json) was healthy for
its first 5 pages, then hit the stuck-SPA state (0.6.1/0.6.2) at page 6 and
never recovered for the rest of the session - 14 pages in a row, all
broken, over 17 straight minutes - because each one still went through its
own full retry-then-reload-twice cycle before giving up, and the crawl just
kept moving to the next page anyway. This was the fifth large automated
walk run that same day; the likeliest explanation is Classroom throttling
the session after enough automated traffic, though that's inferred from
the pattern, not confirmed directly.

Whatever the exact cause, grinding through a queue that's clearly not
working is wasted time, and repeatedly hammering something that might be a
deliberate rate limit is worth stopping, not pushing through. `CIRCUIT_BREAKER_THRESHOLD`
(3) tracks consecutive non-`"ok"` results - `advanceCrawlStep` already
knows this from the envelope's own status, no new signal needed - and once
that many land in a row, `abortCrawl` stops the walk immediately: same
teardown as `finishCrawl` (tab returns home, `pageCrawls` entry cleared),
but with a distinct sticky toast naming what happened and how much was
captured before it did, and `progress.aborted` lets the popup show "stopped
early" instead of "finished" so it's never mistaken for a clean run. A
single bad page still resets the counter back to zero rather than ending
the walk - this is specifically about a *run* of them, not one flaky page.

## Goal: resolve "what class is my child in right now" (not built yet)

The data needed for this already splits across pieces captured today, plus
one piece that isn't captured at all yet:

- **Daily View** gives today's bell schedule: period letter → actual clock
  time — but only for periods that fall on today's specific rotation day.
- **List View** gives the full-year period → class assignment — but no
  clock times, and its `Days 123456` field is a day-of-week/rotation code,
  not a resolved "today" answer.
- **Not yet captured at all**: whatever tells you *which* rotation day
  today is, if the schedule isn't a flat Mon-Fri cycle (the sibling
  `schoolz` repo's own `hs_rotation` scan exists because this district's
  high schools run an A-H day rotation independent of the calendar weekday
  — a real Genesis capture's `"Today's Cycle: 1"` line is a candidate
  source for this, unverified beyond that one observation).

The goal: combine today's rotation day → today's bell times → each
period's class/teacher/room from the full-year schedule into one resolved
answer — "right now/next: Period C, 9:32-10:29 AM, Science of Cooking,
Room B232." This is extraction-layer work (parsing and correlating raw
captures), not a capture-layer change — it belongs wherever a consolidated
"what's my child in right now" view eventually gets built (see
Architecture above), using the raw Genesis captures this extension already
produces as input. Not started.
