/*
 * Backpack Capture — the only sites this extension works on.
 *
 * Chrome itself enforces the real boundary (manifest.json's
 * content_scripts matches and host_permissions): on any other site the
 * extension's code is never loaded. This list mirrors those patterns so the
 * popup can say, in plain words, which sites those are and whether the
 * current tab is one of them. Keep it in sync with manifest.json.
 */
(function (global) {
  const SUPPORTED_SITES = [
    {
      name: "Google Classroom",
      where: "classroom.google.com",
      matches: (u) => u.protocol === "https:" && u.hostname === "classroom.google.com",
    },
    {
      name: "Genesis Parent Portal",
      where: "your school district's Genesis parent pages (…/genesis/parents)",
      matches: (u) => /^https?:$/.test(u.protocol) && /^\/genesis\/parents/i.test(u.pathname),
    },
  ];

  function supportedSite(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return SUPPORTED_SITES.find((site) => site.matches(parsed)) || null;
    } catch (e) {
      return null;
    }
  }

  global.BackpackSites = { SUPPORTED_SITES, supportedSite };
})(globalThis);
