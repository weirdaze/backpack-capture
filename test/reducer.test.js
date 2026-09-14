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

test("account_index is parsed from the /u/<n>/ URL segment", () => {
  loadFixture("classroom-stream.html", "https://classroom.google.com/u/2/c/AAA");
  assert.equal(global.window.BackpackReducer.accountIndexFromUrl("https://classroom.google.com/u/2/c/AAA"), 2);
  assert.equal(global.window.BackpackReducer.accountIndexFromUrl("https://classroom.google.com/h"), null);
});
