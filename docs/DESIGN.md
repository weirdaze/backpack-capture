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
