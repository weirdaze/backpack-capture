const { test } = require("node:test");
const assert = require("node:assert/strict");

require("../src/supported-sites.js");
require("../src/template-builder.js");
const { buildSteps, defaultName, pageCount, PROMPT_LABEL } = globalThis.BackpackTemplates;

const CLASS_A = "https://classroom.google.com/u/2/w/ODcyNDkxNDc4MTk4/t/all";
const CLASS_B = "https://classroom.google.com/u/2/c/ODc2NDQ0NzExNTM3";
const GENESIS = "https://parents.chclc.org/genesis/parents?tab1=studentdata&tab2=studentsummary&studentid=4000319";

test("keeps each page once, in the order it was first captured", () => {
  const steps = buildSteps([{ url: CLASS_A }, { url: CLASS_A }, { url: CLASS_B }, { url: CLASS_A }]);
  assert.deepEqual(steps, [
    { kind: "page", url: CLASS_A },
    { kind: "page", url: CLASS_B },
  ]);
  assert.equal(pageCount(steps), 2);
});

test("a Genesis page captured twice adds a prompt to toggle the view", () => {
  const steps = buildSteps([{ url: GENESIS }, { url: GENESIS }, { url: CLASS_A }]);
  assert.deepEqual(steps, [
    { kind: "page", url: GENESIS },
    { kind: "prompt", url: GENESIS, label: PROMPT_LABEL },
    { kind: "page", url: CLASS_A },
  ]);
  assert.equal(pageCount(steps), 2);
});

test("a Genesis page captured once needs no prompt", () => {
  assert.deepEqual(buildSteps([{ url: GENESIS }]), [{ kind: "page", url: GENESIS }]);
});

test("a Classroom page captured twice is just one step (scroll recapture)", () => {
  assert.deepEqual(buildSteps([{ url: CLASS_A }, { url: CLASS_A }]), [{ kind: "page", url: CLASS_A }]);
});

test("unsupported and malformed addresses never become steps", () => {
  assert.deepEqual(buildSteps([{ url: "https://mail.google.com/" }, { url: "nope" }, {}, null]), []);
  assert.deepEqual(buildSteps([]), []);
  assert.deepEqual(buildSteps(undefined), []);
});

test("default name is the date the route was saved", () => {
  assert.equal(defaultName(new Date("2026-09-15T18:04:00Z")), "Route from 2026-09-15");
});
