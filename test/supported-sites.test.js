const { test } = require("node:test");
const assert = require("node:assert/strict");

require("../src/supported-sites.js");
const { supportedSite } = globalThis.BackpackSites;

test("recognizes Google Classroom and Genesis Parent Portal pages", () => {
  assert.equal(supportedSite("https://classroom.google.com/u/2/h").name, "Google Classroom");
  assert.equal(supportedSite("https://parents.chclc.org/genesis/parents?tab1=studentdata").name, "Genesis Parent Portal");
});

test("every other page is unsupported", () => {
  for (const url of [
    "https://mail.google.com/mail/u/0/",
    "http://classroom.google.com/u/0/h",
    "https://classroom.google.com.example.com/",
    "https://example.com/?next=/genesis/parents",
    "https://example.com/other/genesis/parents",
    "chrome://extensions",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(supportedSite(url), null, String(url));
  }
});
