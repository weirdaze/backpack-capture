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
- **Genesis and other portals.** The same technique should generalize, but
  each portal is its own adapter with its own DOM shape to verify against a
  real capture first.
