# Backpack Capture

A Chrome extension that reads a Google Classroom or Genesis Parent Portal
page you're already logged into and reduces it down to a small, structured
JSON file — so you can pull "what's due" (Classroom) or a class schedule
(Genesis) out without doing "Save As" and hand-parsing an HTML file every
time.

**It only works on Google Classroom and Genesis Parent Portal pages.** On
every other website Chrome never loads it, so it can't see or record the
rest of your browsing. **Nothing is captured until you press Start
capture.**

**It is read-only and local-only.** It never logs in, never submits a form,
never reads cookies or your password, and never sends anything over the
network on its own. The only network-shaped thing it does is let *you*
save an export file at the end.

## Why it works this way

Google Classroom (and Genesis, and similar school portals) don't have a
public API a parent can use, and a district-managed student Google account
generally can't grant a personal app OAuth consent for Classroom scopes
anyway. Scripted logins get flagged by bot detection. The one thing that
reliably works is reading the DOM of a session **the human already opened**
— which is exactly what this extension does: it never touches the login,
it only reads the page after you're already looking at it.

The full design rationale (including why this is a browser extension and
not, say, an API integration) lives in [`docs/DESIGN.md`](docs/DESIGN.md),
ported from the original design notes.

## What it does

1. You press **Start capture** in the toolbar popup, then open
   `classroom.google.com` or a Genesis Parent Portal page
   (`.../genesis/parents?...`) in a normal, logged-in Chrome tab.
2. The extension waits for the page to finish rendering (Classroom paints
   progressively and lazy-loads content as you scroll), then reads the DOM.
3. It strips out scripts, styles, SVGs, inline images, and every CSS class
   name — none of that carries real signal, and both sites' class names are
   auto-generated and change without notice. On Classroom it **keeps**
   `aria-label`, `role`, `title`, `href`, `datetime`, and `data-*`
   attributes, because the assignment title and due date live in
   `aria-label`, not in the visible text:
   ```
   aria-label="Assignment: Quiz: The Americas and Europe Before 1492, due Tomorrow"
   ```
   Genesis turned out to carry no semantic attributes like that at all —
   its schedule data (class name, teacher, room, period, days) is plain
   nested `<div>` text, so the Genesis adapter keeps that visible text in
   document order instead (see `docs/DESIGN.md` for how this was confirmed
   against a real capture).
4. The reduced text (not the raw HTML) is stored locally in the extension's
   own storage, tagged with a timestamp, timezone, source URL, and which
   Google account (`/u/0/`, `/u/1/`, ...) or Genesis student id it came from.
5. You open the toolbar popup and click **Export capture** whenever you want
   a file — nothing leaves the browser before that.

On a real Classroom stream page this reduces a ~1.8MB saved page down to
roughly 80KB of actual signal; on a real Genesis student-summary page it's
~168KB down to ~8KB — see `test/reducer.test.js` and
`test/genesis-reducer.test.js` for the regression coverage.

## What it does *not* do

- It does not log in for you, submit any form, or click anything on
  Google's side. If you're not logged in, it detects the login page and
  refuses to store a capture instead of silently saving "nothing." The one
  navigation it *will* do is opt-in: with **Also open each assignment page**
  checked, it drives the current tab to a real link Classroom already
  rendered and back — the same address-based approach templates use, never
  a click or a form submission.
- It does not extract structured due-dates/assignments for you — that's a
  deliberately separate next step (see [Scope](#scope-of-this-repo) below).
  This repo only produces the reduced JSON; turning that into a due-work
  list is a follow-up project.
- It does not read cookies, `localStorage`, or anything else that could
  authenticate as you. Check `manifest.json` — the only permissions are
  `storage`, `downloads`, `scripting`, `activeTab`, and host access to
  `classroom.google.com` and `*/genesis/parents*` only.
- It does not talk to any server. There is no telemetry, no analytics, no
  crash reporting, no API calls anywhere in this extension.
- It currently has adapters for Google Classroom and the Genesis Parent
  Portal. Other portals (ClassDojo, Remind, ...) are a documented future
  step, not built yet — see `docs/DESIGN.md`.
- The Genesis host permission (`*://*/genesis/parents*`) matches any
  district's Genesis instance by path, since every Genesis deployment uses
  that same `/genesis/parents` URL structure on its own subdomain — it is
  not scoped to one specific district's domain.

## Installing (there is no Chrome Web Store listing)

This isn't published to the Chrome Web Store, so install it as an unpacked
extension:

1. Download the latest release zip from
   [Releases](../../releases) and unzip it, **or** clone this repo.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder you unzipped/cloned (the
   one containing `manifest.json`).
5. Click the Backpack icon in the toolbar, press **Start capture**, and open
   a Google Classroom page. You should see a small "Backpack captured this
   page" toast in the bottom right after a moment.

> **A managed/school Chrome profile may block this.** Some districts push a
> policy (`ExtensionInstallBlocklist`) that prevents installing *any*
> unapproved extension, including in developer mode, on a profile signed in
> with a managed account. If that's the case for the account you care about,
> this extension can't help there — see `docs/DESIGN.md`'s "Verification
> protocol" section for how to check, and what the fallback looks like.

## Using it

1. Click the Backpack icon in Chrome's toolbar and press **Start capture**.
   A red **REC** badge sits on the icon while capture is on.
2. Browse your child's Google Classroom and Genesis pages the way you
   normally would. Every page you open is saved once it finishes loading
   (including switching between classes, which Classroom does without
   reloading), and scrolling down and pausing picks up items that load as
   you scroll. There's nothing to click on each page.
3. Press **End capture** when you're done. Capture also turns itself off
   whenever Chrome restarts, so it's never left running by accident.
4. Press **Export capture** and choose where to save. The file contains
   every saved page, each with its own timestamp, address, account index,
   and reduced text.

- **One page only**: **Capture just this page** saves the current tab once,
  without starting a session.
- **Undo**: right after a capture, the toast that appears has an **Undo**
  button for a few seconds.
- **Delete**: open the popup to see every stored capture with a status
  badge (`ok` / `low confidence` / `layout changed?` / `login wall`) and
  delete any of them individually, or clear everything.

### Following each assignment's own page

A class's stream or Classwork list often only shows a title and due date —
the actual instructions ("how to do this," what's expected) live on the
assignment's own details page. Check **Also open each assignment/material
page** before pressing **Start capture** and, every time a Classwork page is
captured, the same tab briefly opens each assignment or material it links
to, captures that page too, then returns to where it was. It's on-screen
the whole time — the tab visibly navigates away and back, with a toast
naming how many pages it's about to open — never a background fetch.

This prefers a **real link Classroom itself rendered** on the page. Where
one doesn't exist — confirmed the norm on a Classwork page, where every item
tends to render as a plain button, not a link — its details address is
instead built from its own id, using an encoding verified exact against a
real capture (see `docs/DESIGN.md`), rather than left out. It won't re-open
something already captured this session, and it caps how many pages it'll
open per Classwork page visited so one very full class can't turn a quick
check into an open-ended crawl.

### Walking every class from the homepage

The option above only follows links on whatever page you're already
looking at. To capture every assignment for every class in one go, open
the Classroom homepage, check **Starting from the Classroom homepage: also
walk every active class**, then press **Start capture**. The tab visits
each class's Classwork page (the complete, topic-organized list — not the
Stream, which Google's own Classroom help documents as a message board and
which several teachers have reported capping out at a handful of recent
posts), captures it, opens each assignment/material it finds there, then
moves to the next class, and finally returns to the homepage. A toast
tracks it the whole way.

This is a much bigger action than the per-page option — up to 10 classes
times 20 items each, which can take a while and means the tab is out of
your hands for a stretch — so it's capped, off by default, and only ever
triggered by actually landing on the homepage. It only ever walks classes
the homepage lists as active; Classroom keeps archived classes behind a
separate link this never follows. Like everything else here, it never
clicks anything on the site's side — it only ever drives the tab to an
address, whether that's a real link Classroom rendered or (for a course's
Classwork tab, and for an item with no real link on it) one built from an
id in a way verified against a real capture, not guessed at.

It also skips anything left over from before this school year — a class
like a student-government feed can carry posts going back years, and
walking those too would just cost time for content that's no longer
relevant. An item's own due date (or, for one with no due date at all, its
posting date) decides this; one with no usable date either way is kept
rather than guessed at.

While a walk is running, the popup shows two progress bars: which class
it's on out of how many, and how many pages it's captured in total. The
total keeps growing as each class's own items are discovered, so it's a
live count, not a fixed target known from the start.

If several pages in a row come back broken — seen in practice after
several large walks in one day, likely Classroom pushing back on the
volume of automated traffic — the walk stops itself rather than grinding
through the rest of the queue producing more of the same. The popup shows
**Walk stopped early** instead of **Walk finished** when this happens; give
it a while before trying again.

### Templates — do the same round again another day

A capture session is usually the same little tour every time: each class's
Classwork page, then the Genesis schedule and grades. You can save that
tour once and replay it whenever you want a fresh export.

1. Press **Start capture**, click through the pages you care about, then
   press **End capture**.
2. Press **Save last session as a template** and give it a name.
3. Any day after that, press **Replay** next to the template. It opens a new
   tab, walks the same pages in the same order, captures each one, and tells
   you how many it got. Then press **Export capture**.

A template stores **addresses and their order**, not clicks — every page
worth capturing has its own URL, so replay doesn't depend on Google's
markup, which changes without notice. The one exception is Genesis's List
View / Daily View toggle, which swaps content without changing the URL: if
your recorded session toggled it, replay pauses on that page and asks you to
click the view yourself (**Done** / **Skip** in the toast). The extension
never clicks the site's own controls for you.

Templates have their own **✕** and are **not** removed by **Clear all** —
that button only deletes captured pages. Class and student ids stay stable
within a school year, so a template should last the year; re-record it after
a rollover, or if a replayed step reports nothing captured.

## Status badges, and why they exist

A capture that "succeeds" but silently contains nothing useful is worse
than an error — you'd trust an empty list. So every capture gets tagged:

| Badge | Meaning |
|---|---|
| `ok` | Looks like a normal capture with real content. |
| `low confidence` | Very little text came out — the page may not have loaded fully. |
| `layout changed?` | The page didn't match the expected shape (Classroom: an `Assignment:`/`Material:`/`Announcement` `aria-label`; Genesis: a `Period <letter>` marker). The site may have changed its markup; the capture is still saved for inspection, but treat it as suspect. |
| `login wall` | Never stored at all — detected as a sign-in redirect, on purpose, so it can't overwrite a good capture with nothing. |

Classroom's own app can also get stuck mid-navigation — a real "Refresh
your browser to update this page" banner, seen during long automated runs.
Waiting longer doesn't clear that on its own, so once the normal retries
are exhausted, the extension forces a real page reload (exactly what that
banner itself is asking for) — up to twice per page, since one reload
wasn't always enough in practice. If it's still stuck after that, the page
saves as `layout changed?` like any other capture that didn't pan out.

## Scope of this repo

This extension is **just the capture layer** (what the design notes call
"Tier 1"). It intentionally stops at "export a small, honest JSON file" —
it does not do due-date extraction, cross-source dedup, or provide a "what's
due" UI. Those are separate, larger pieces (an extraction pass, a local
store, a desktop app) that aren't built yet. If you're looking for that
whole picture, read `docs/DESIGN.md`.

This also is **not** affiliated with, endorsed by, or a feature of Google
Classroom, Genesis, or any school district.

## Privacy

- **It only works on two kinds of site**: Google Classroom
  (`classroom.google.com`) and Genesis Parent Portal pages
  (`…/genesis/parents`). Chrome enforces this through `manifest.json`'s
  content-script matches and host permissions: on every other website the
  extension's code is never loaded, so it can't see, read, or record the
  rest of your browsing. The popup lists both sites and tells you whether
  the current tab is one of them (`src/supported-sites.js`).
- **Nothing is captured until you press Start capture.** A red REC badge
  shows while it's on, and it turns off when you press End capture or
  Chrome restarts.
- Everything stays in the browser's local extension storage until you
  explicitly export it.
- No network requests anywhere in this codebase — you can verify this by
  reading `src/*.js` (there is no `fetch`, no `XMLHttpRequest`, no analytics
  SDK).
- Uninstalling the extension deletes all locally stored captures.
- Because this handles a child's education records, treat exported JSON
  files the same way you'd treat a saved report card or homework folder —
  it's yours, but it's still their data.

## Development

```
npm install
npm test        # runs the reducer test suite (node:test + jsdom) against fixtures
```

`src/reducer.js` has no `chrome.*` dependency by design, so it can be loaded
and tested outside the browser — see `test/reducer.test.js` and
`test/fixtures/`.

## License

MIT — see [`LICENSE`](LICENSE).
