const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

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
    href: "https://classroom.google.com/u/0/c/ODcyNDkxNDc4MTk4",
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
