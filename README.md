# Backpack Capture

A Chrome extension that reads a Google Classroom or Genesis Parent Portal
page you're already logged into and reduces it down to a small, structured
JSON file — so you can pull "what's due" (Classroom) or a class schedule
(Genesis) out without doing "Save As" and hand-parsing an HTML file every
time.

**It is read-only and local-only.** It never logs in, never submits a form,
never reads cookies or your password, and never sends anything over the
network on its own. The only network-shaped thing it does is let *you*
download a JSON file at the end.

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

1. You open `classroom.google.com` or a Genesis Parent Portal page
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
5. You open the toolbar popup and click **Export JSON** whenever you want a
   file — nothing leaves the browser before that.

On a real Classroom stream page this reduces a ~1.8MB saved page down to
roughly 80KB of actual signal; on a real Genesis student-summary page it's
~168KB down to ~8KB — see `test/reducer.test.js` and
`test/genesis-reducer.test.js` for the regression coverage.

## What it does *not* do

- It does not log in for you, submit any form, or automate anything on
  Google's side. If you're not logged in, it detects the login page and
  refuses to store a capture instead of silently saving "nothing."
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
5. Open a Google Classroom page. You should see a small "Backpack captured
   this page" toast in the bottom right after a moment.

> **A managed/school Chrome profile may block this.** Some districts push a
> policy (`ExtensionInstallBlocklist`) that prevents installing *any*
> unapproved extension, including in developer mode, on a profile signed in
> with a managed account. If that's the case for the account you care about,
> this extension can't help there — see `docs/DESIGN.md`'s "Verification
> protocol" section for how to check, and what the fallback looks like.

## Using it

- **Automatic capture**: just browse Classroom normally. Every page load
  auto-captures after it settles; scrolling further down and pausing
  re-captures to pick up newly-revealed (lazy-loaded) items.
- **Manual capture**: click the toolbar icon → **Capture this tab**.
- **Export**: click the toolbar icon → **Export JSON** → choose where to
  save. The file contains every capture currently stored, each with its
  own timestamp, source URL, account index, and reduced text.
- **Undo**: right after a capture, the toast that appears has an **Undo**
  button for a few seconds.
- **Delete**: open the popup to see every stored capture with a status
  badge (`ok` / `low confidence` / `layout changed?` / `login wall`) and
  delete any of them individually, or clear everything.

## Status badges, and why they exist

A capture that "succeeds" but silently contains nothing useful is worse
than an error — you'd trust an empty list. So every capture gets tagged:

| Badge | Meaning |
|---|---|
| `ok` | Looks like a normal capture with real content. |
| `low confidence` | Very little text came out — the page may not have loaded fully. |
| `layout changed?` | The page didn't match the expected shape (Classroom: an `Assignment:`/`Material:`/`Announcement` `aria-label`; Genesis: a `Period <letter>` marker). The site may have changed its markup; the capture is still saved for inspection, but treat it as suspect. |
| `login wall` | Never stored at all — detected as a sign-in redirect, on purpose, so it can't overwrite a good capture with nothing. |

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
