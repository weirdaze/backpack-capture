const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

// Pinned so tests using it never depend on which real day they happen to run.
const SEPT_18_2026 = new Date(2026, 8, 18);

function loadFixture(name, url) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
  const dom = new JSDOM(html, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  delete require.cache[require.resolve("../src/core-reduce.js")];
  delete require.cache[require.resolve("../src/reducer.js")];
  require("../src/core-reduce.js");
  require("../src/reducer.js");
  return dom;
}

test("strips script/style/svg/noscript and drops empty wrapper divs", () => {
  const dom = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.text.includes("should be stripped"), false);
  assert.equal(reduced.text.includes("color: red"), false);
});

test("keeps aria-label, href, and data-* attributes on retained nodes", () => {
  const dom = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.match(reduced.text, /Assignment: Chapter 4 Reading Response, due Tomorrow/);
  assert.match(reduced.text, /href: https:\/\/classroom\.google\.com\/u\/0\/c\/AAA\/a\/BBB\/details/);
  assert.match(reduced.text, /data-stream-item-id: 1111111111/);
});

test("never anchors on class names — they are dropped entirely", () => {
  const dom = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(/CLASS_/.test(reduced.text), false);
});

test("drops data: URI attribute values", () => {
  const dom = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.text.includes("base64"), false);
});

test("expected-shape assertion passes on a real assignment stream", () => {
  const dom = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.shapeOk, true);
  assert.equal(reduced.loginWall, false);
});

test("detects a login wall and never reports shapeOk on it", () => {
  const dom = loadFixture("classroom-login-wall.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.loginWall, true);
  assert.equal(reduced.shapeOk, false);
});

test("detects a login wall purely from an accounts.google.com URL", () => {
  const dom = loadFixture("classroom-stream.html", "https://accounts.google.com/signin");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.loginWall, true);
});

test("detects Classroom's own stuck-SPA refresh banner", () => {
  const url = "https://classroom.google.com/u/0/c/AAA/a/BBB/details";
  const dom = loadFixture("classroom-needs-refresh.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  assert.equal(reduced.needsRefresh, true);
});

test("never reports needsRefresh on an ordinary page", () => {
  const dom = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/AAA");
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.needsRefresh, false);
});

test("leaves out the previously opened class's cached view", () => {
  const url = "https://classroom.google.com/u/2/w/ODcyNDkxNDc4MTk4/t/all";
  const dom = loadFixture("classroom-stale-view.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  assert.equal(reduced.viewReady, true);
  assert.match(reduced.text, /C1L3 Intro to Geometry/);
  assert.equal(reduced.text.includes("F451"), false);
  assert.equal(reduced.text.includes("ODc2NDQ0NzExNTM3\"]"), false);

  const englishUrl = "https://classroom.google.com/u/2/w/ODc2NDQ0NzExNTM3/t/all";
  const english = dom.window.BackpackReducer.reduce(dom.window.document.body, { url: englishUrl });
  assert.match(english.text, /F451/);
  assert.equal(english.text.includes("C1L3"), false);
  assert.equal(dom.window.BackpackReducer.classIdFromUrl(englishUrl), "ODc2NDQ0NzExNTM3");
});

test("not ready while only another class's view is rendered", () => {
  const url = "https://classroom.google.com/u/2/w/ODcyNDkxNDc4MTk4/t/all";
  const dom = loadFixture("classroom-stale-view.html", url);
  dom.window.document.querySelector('[data-view-id="ucc-97"]').remove();
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  assert.equal(reduced.viewReady, false);
});

test("pages without a class in the URL or without view roots never block", () => {
  const dom = loadFixture("classroom-stale-view.html", "https://classroom.google.com/u/2/h");
  const R = dom.window.BackpackReducer;
  assert.equal(R.reduce(dom.window.document.body, { url: "https://classroom.google.com/u/2/h" }).viewReady, true);
  const plain = loadFixture("classroom-stream.html", "https://classroom.google.com/u/0/c/ODcyNDkxNDc4MTk4");
  assert.equal(
    plain.window.BackpackReducer.reduce(plain.window.document.body, { url: "https://classroom.google.com/u/0/c/ODcyNDkxNDc4MTk4" }).viewReady,
    true
  );
  assert.equal(R.classIdFromUrl("https://classroom.google.com/u/0/c/AAA"), null);
});

test("account_index is parsed from the /u/<n>/ URL segment", () => {
  loadFixture("classroom-stream.html", "https://classroom.google.com/u/2/c/AAA");
  assert.equal(global.window.BackpackReducer.accountIndexFromUrl("https://classroom.google.com/u/2/c/AAA"), 2);
  assert.equal(global.window.BackpackReducer.accountIndexFromUrl("https://classroom.google.com/h"), null);
});

test("extractDetailLinks follows real assignment and material anchors only", () => {
  const url = "https://classroom.google.com/u/0/c/AAA";
  const dom = loadFixture("classroom-detail-links.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });

  assert.equal(reduced.detailLinks.length, 3); // deduped, and the two hrefless/non-details items left out

  const assignment = reduced.detailLinks.find((l) => l.href.endsWith("/a/BBB/details"));
  assert.deepEqual(assignment, {
    href: "https://classroom.google.com/u/0/c/AAA/a/BBB/details",
    kind: "assignment",
    title: "Chapter 4 Reading Response",
    due: "Tomorrow",
  });

  const material = reduced.detailLinks.find((l) => l.href.endsWith("/m/DDD/details"));
  assert.deepEqual(material, {
    href: "https://classroom.google.com/u/0/c/AAA/m/DDD/details", // resolved from a relative href
    kind: "material",
    title: "How To Craft A Thesis Statement",
    due: null,
  });
});

test("extractDetailLinks follows a real anchor even when its label doesn't match the Assignment:/Material: convention", () => {
  const url = "https://classroom.google.com/u/0/c/AAA";
  const dom = loadFixture("classroom-detail-links.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  const unlabeled = reduced.detailLinks.find((l) => l.href.endsWith("/a/EEE/details"));
  assert.deepEqual(unlabeled, {
    href: "https://classroom.google.com/u/0/c/AAA/a/EEE/details",
    kind: "assignment", // read off the URL's own /a/ segment, not the label
    title: null,
    due: null,
  });
});

test("extractDetailLinks never invents a URL for an item with no real anchor", () => {
  const url = "https://classroom.google.com/u/0/c/AAA";
  const dom = loadFixture("classroom-detail-links.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  assert.equal(
    reduced.detailLinks.some((l) => l.title === "Using Book Covers To Make Inferences"),
    false
  );
});

test("extractCourseLinks finds real course-tile/nav links, deduped, archived excluded", () => {
  const url = "https://classroom.google.com/u/0/c/AAA";
  const dom = loadFixture("classroom-detail-links.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });

  assert.equal(reduced.courseLinks.length, 2); // Geometry + English, deduped by class id

  const geometry = reduced.courseLinks.find((l) => l.classId === "ODcyNDkxNDc4MTk4");
  assert.deepEqual(geometry, {
    href: "https://classroom.google.com/u/0/c/ODcyNDkxNDc4MTk4", // the course's Stream page - never visited directly
    classworkHref: "https://classroom.google.com/u/0/w/ODcyNDkxNDc4MTk4/t/all", // what the crawl actually visits
    classId: "ODcyNDkxNDc4MTk4",
    title: "GEOM A Per A 2026-27 210-1",
  });

  // English appears twice (nav + tile) - only the first is kept
  const english = reduced.courseLinks.find((l) => l.classId === "ODc2NDQ0NzExNTM3");
  assert.equal(english.title, "ENG 2A Block B (26-27) 121-1");

  // the archived-classes link, and the non-class-id "AAA" course-home link,
  // must never be mistaken for a course
  assert.equal(
    reduced.courseLinks.some((l) => l.href.includes("archived") || l.classId === "AAA"),
    false
  );
});

test("extractCourseLinks builds the Classwork URL under the page's own account index", () => {
  const url = "https://classroom.google.com/u/2/c/AAA";
  const dom = loadFixture("classroom-detail-links.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  const geometry = reduced.courseLinks.find((l) => l.classId === "ODcyNDkxNDc4MTk4");
  assert.equal(geometry.classworkHref, "https://classroom.google.com/u/2/w/ODcyNDkxNDc4MTk4/t/all");
});

test("reconstructWorkItemLinks builds a details link for a button-only work item", () => {
  const url = "https://classroom.google.com/u/0/w/ODcyNDkxNDc4MTk4/t/all";
  const dom = loadFixture("classroom-classwork-buttons.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url, now: SEPT_18_2026 });

  const assignment = reduced.detailLinks.find((l) => l.href.includes("ODg0ODkwMTc5OTMz"));
  assert.deepEqual(assignment, {
    href: "https://classroom.google.com/u/0/c/ODcyNDkxNDc4MTk4/a/ODg0ODkwMTc5OTMz/details",
    kind: "assignment",
    title: '"Why Novels Have First Pages"', // the trailing " Assignment" is stripped, and it's not the "options for ..." tooltip label
    due: "Today",
    created: null,
  });

  const material = reduced.detailLinks.find((l) => l.href.includes("/m/") && l.kind === "material");
  assert.equal(material.title, "Syllabus");
});

test("reconstructWorkItemLinks never duplicates an item that already has a real anchor", () => {
  const url = "https://classroom.google.com/u/0/w/ODcyNDkxNDc4MTk4/t/all";
  const dom = loadFixture("classroom-classwork-buttons.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url, now: SEPT_18_2026 });

  const matches = reduced.detailLinks.filter((l) => l.href.endsWith("/a/ODg1NDczNzA5Mjcz/details"));
  assert.equal(matches.length, 1); // the real anchor's own due date survives, not overwritten
  assert.equal(matches[0].due, "Friday");
});

test("a leftover item from last school year is filtered out of detailLinks", () => {
  const url = "https://classroom.google.com/u/0/w/ODcyNDkxNDc4MTk4/t/all";
  const dom = loadFixture("classroom-classwork-buttons.html", url);
  const inSeptember = dom.window.BackpackReducer.reduce(dom.window.document.body, { url, now: SEPT_18_2026 });
  assert.equal(
    inSeptember.detailLinks.some((l) => l.href.includes("ODYzNjc0OTA2Nzk0")),
    false
  );

  // The same item, captured back when it was actually posted, must not be
  // filtered - this only excludes genuinely stale items, not everything
  // with a bare month/day.
  const backInMay = dom.window.BackpackReducer.reduce(dom.window.document.body, { url, now: new Date(2026, 4, 10) });
  assert.equal(
    backInMay.detailLinks.some((l) => l.href.includes("ODYzNjc0OTA2Nzk0")),
    true
  );
});

test("reconstructWorkItemLinks stays empty on a page with no class in the URL", () => {
  const url = "https://classroom.google.com/u/0/h/st";
  const dom = loadFixture("classroom-classwork-buttons.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  // The button-only items (no real anchor) can't be reconstructed with no
  // class id to build from; the one item with a real anchor is unaffected,
  // since extractDetailLinks never depended on the page's own class id.
  assert.equal(reduced.detailLinks.length, 1);
  assert.equal(reduced.detailLinks[0].title, "Real Anchor Item");
});

test("reconstructWorkItemLinks never fires while a stale cross-class view is still detected", () => {
  const url = "https://classroom.google.com/u/2/w/ODcyNDkxNDc4MTk4/t/all";
  const dom = loadFixture("classroom-stale-view.html", url);
  dom.window.document.querySelector('[data-view-id="ucc-97"]').remove(); // only the other class's view is left
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url });
  assert.equal(reduced.viewReady, false);
  assert.deepEqual(reduced.detailLinks, []);
});

test("reconstructWorkItemLinks fires once the page's own view is present", () => {
  const url = "https://classroom.google.com/u/2/w/ODc2NDQ0NzExNTM3/t/all";
  const dom = loadFixture("classroom-stale-view.html", url);
  const reduced = dom.window.BackpackReducer.reduce(dom.window.document.body, { url, now: SEPT_18_2026 });
  assert.equal(reduced.viewReady, true);
  const link = reduced.detailLinks.find((l) => l.href.includes("ODc2NDQ0NzExNTM3"));
  assert.deepEqual(link, {
    href: "https://classroom.google.com/u/2/c/ODc2NDQ0NzExNTM3/a/ODg0ODg5OTM4OTg1/details",
    kind: "assignment",
    title: "Part One of F451 + Study Guide (DUE)",
    due: "Sep 23",
    created: null,
  });
});

test("resolveNearestDate picks whichever year is fewest days from now", () => {
  const R = global.window.BackpackReducer;
  const now = new Date(2026, 8, 18); // September 18, 2026
  // "May 11" is ~4 months in the past vs. ~8 months in the future - the
  // past occurrence is nearer, and must win.
  assert.deepEqual(R.resolveNearestDate("Due May 11, 7:30 AM", now), new Date(2026, 4, 11));
  // "Jan 15" is ~4 months in the future vs. ~8 months in the past - the
  // future occurrence is nearer.
  assert.deepEqual(R.resolveNearestDate("Jan 15", now), new Date(2027, 0, 15));
  assert.equal(R.resolveNearestDate("Due Tomorrow", now), null);
  assert.equal(R.resolveNearestDate("", now), null);
});

test("isWithinCurrentSchoolYear excludes a leftover date from before school-year start", () => {
  const R = global.window.BackpackReducer;
  const now = new Date(2026, 8, 18); // September 18, 2026 - school year started August 1, 2026
  assert.equal(R.isWithinCurrentSchoolYear("May 8", now), false); // resolves to May 2026, before Aug 1, 2026
  assert.equal(R.isWithinCurrentSchoolYear("Jan 15", now), true); // resolves to Jan 2027, within this school year
  assert.equal(R.isWithinCurrentSchoolYear("Today", now), true); // never resolved as a date at all
  assert.equal(R.isWithinCurrentSchoolYear("Wednesday", now), true);
  assert.equal(R.isWithinCurrentSchoolYear(null, now), true); // no signal - never filtered for lack of information
  assert.equal(R.isWithinCurrentSchoolYear("blah blah", now), true); // unparseable - same default
});

test("schoolYearStart lands on August 1st of the correct year on both sides of the boundary", () => {
  const R = global.window.BackpackReducer;
  assert.deepEqual(R.schoolYearStart(new Date(2026, 8, 18)), new Date(2026, 7, 1)); // September -> this year
  assert.deepEqual(R.schoolYearStart(new Date(2027, 3, 1)), new Date(2026, 7, 1)); // April -> still last August
  assert.deepEqual(R.schoolYearStart(new Date(2026, 7, 15)), new Date(2026, 7, 1)); // August itself
});

test("parseWorkItemLabel strips quotes and the due-date suffix", () => {
  const R = global.window.BackpackReducer;
  assert.deepEqual(R.parseWorkItemLabel('Assignment: "Why Novels Have First Pages" Assignment, due Tomorrow'), {
    kind: "assignment",
    title: '"Why Novels Have First Pages" Assignment',
    due: "Tomorrow",
  });
  assert.deepEqual(R.parseWorkItemLabel("Material: Journal Entry #1"), {
    kind: "material",
    title: "Journal Entry #1",
    due: null,
  });
  assert.equal(R.parseWorkItemLabel("Announcement: Picture day is Friday"), null);
});
