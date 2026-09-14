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
  delete require.cache[require.resolve("../src/genesis-reducer.js")];
  require("../src/core-reduce.js");
  require("../src/genesis-reducer.js");
  return dom;
}

const SUMMARY_URL = "https://parents.example-district.org/genesis/parents?tab1=studentdata&tab2=studentsummary&studentid=1234567";

test("strips script/style/noscript and drops empty wrapper divs", () => {
  const dom = loadFixture("genesis-summary.html", SUMMARY_URL);
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.text.includes("should be stripped"), false);
  assert.equal(reduced.text.includes("color: red"), false);
});

test("keeps course card fields in document order (no aria-label needed)", () => {
  const dom = loadFixture("genesis-summary.html", SUMMARY_URL);
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  const lines = reduced.text.split("\n");
  const idx = lines.indexOf("ALGEBRA I");
  assert.ok(idx >= 0, "course name line should be present");
  assert.deepEqual(lines.slice(idx, idx + 9), [
    "ALGEBRA I",
    "FY",
    "Smith/Jones",
    "Room",
    "C101",
    "Period",
    "A",
    "Days",
    "123456",
  ]);
});

test("excludes the Google Translate widget subtree entirely", () => {
  const dom = loadFixture("genesis-summary.html", SUMMARY_URL);
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.text.includes("Select Language"), false);
  assert.equal(reduced.text.includes("Language Translate Widget"), false);
});

test("drops data: URI images", () => {
  const dom = loadFixture("genesis-summary.html", SUMMARY_URL);
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.text.includes("base64"), false);
});

test("expected-shape assertion passes on a real schedule page", () => {
  const dom = loadFixture("genesis-summary.html", SUMMARY_URL);
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.shapeOk, true);
  assert.equal(reduced.loginWall, false);
});

test("expected-shape assertion also passes on the Daily View rendering (no literal 'Period' text)", () => {
  const dom = loadFixture("genesis-daily-view.html", SUMMARY_URL);
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.shapeOk, true);
  assert.equal(reduced.loginWall, false);
  assert.match(reduced.text, /ALGEBRA I/);
  assert.match(reduced.text, /Room: C101 FY/);
});

test("detects a login wall when the /genesis/parents path was never reached", () => {
  const dom = loadFixture("genesis-login.html", "https://parents.example-district.org/genesis/");
  const reduced = dom.window.BackpackGenesisReducer.reduce(dom.window.document.body, { url: dom.window.location.href });
  assert.equal(reduced.loginWall, true);
  assert.equal(reduced.shapeOk, false);
});

test("studentIdFromUrl reads the studentid query param", () => {
  loadFixture("genesis-summary.html", SUMMARY_URL);
  assert.equal(global.window.BackpackGenesisReducer.studentIdFromUrl(SUMMARY_URL), "1234567");
  assert.equal(
    global.window.BackpackGenesisReducer.studentIdFromUrl("https://parents.example-district.org/genesis/parents?tab1=studentdata"),
    null
  );
});
