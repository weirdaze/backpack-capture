const { test } = require("node:test");
const assert = require("node:assert/strict");

require("../src/auto-walk.js");
const W = globalThis.BackpackAutoWalk;

const ON = { enabled: true, studentId: "s1" };
const at = (h, m = 0) => new Date(2026, 8, 24, h, m);

test("homeUrl builds the account's Classroom homepage", () => {
  assert.equal(W.homeUrl(0), "https://classroom.google.com/u/0/h");
  assert.equal(W.homeUrl("2"), "https://classroom.google.com/u/2/h");
  assert.equal(W.homeUrl(-1), "https://classroom.google.com/u/0/h");
  assert.equal(W.homeUrl("x"), "https://classroom.google.com/u/0/h");
});

test("quiet hours wrap past midnight", () => {
  for (const h of [22, 23, 0, 3, 5]) assert.equal(W.inQuietHours(at(h), {}), true, `hour ${h}`);
  for (const h of [6, 7, 12, 21]) assert.equal(W.inQuietHours(at(h), {}), false, `hour ${h}`);
  assert.equal(W.inQuietHours(at(3), { quietStartHour: 0, quietEndHour: 0 }), false);
  assert.equal(W.inQuietHours(at(13), { quietStartHour: 12, quietEndHour: 14 }), true);
});

test("skipReason: disabled, no student, quiet hours", () => {
  assert.equal(W.skipReason({}, at(10), null), "disabled");
  assert.equal(W.skipReason({ enabled: true }, at(10), null), "no_student");
  assert.equal(W.skipReason(ON, at(23), null), "quiet_hours");
  assert.equal(W.skipReason(ON, at(10), null), null);
});

test("skipReason: waits out the interval, with a little slack for the hourly tick", () => {
  const last = { startedAt: at(8).toISOString() };
  assert.equal(W.skipReason(ON, at(11), last), "not_due");
  assert.equal(W.skipReason(ON, at(11, 56), last), null);
  assert.equal(W.skipReason(ON, at(12, 30), last), null);
  assert.equal(W.skipReason({ ...ON, intervalHours: 6 }, at(12, 30), last), "not_due");
});

test("seen detail pages expire a day after they were first opened", () => {
  const day = W.DETAIL_REFRESH_MS;
  let seen = W.mergeSeenDetails({}, ["a", "b"], 0);
  seen = W.mergeSeenDetails(seen, ["a", "c"], day / 2); // re-visiting "a" doesn't renew it
  assert.deepEqual(seen, { a: 0, b: 0, c: day / 2 });
  assert.deepEqual(W.pruneSeenDetails(seen, day), { c: day / 2 });
});

test("capturesSince only sends what's new since the last publish", () => {
  const caps = [
    { id: 3, captured_at: "2026-09-24T14:00:00.000Z" },
    { id: 2, captured_at: "2026-09-24T10:00:00.000Z" },
    { id: 1, captured_at: "2026-09-24T06:00:00.000Z" },
  ];
  assert.deepEqual(W.capturesSince(caps, null).map((c) => c.id), [3, 2, 1]);
  assert.deepEqual(W.capturesSince(caps, "2026-09-24T10:00:00.000Z").map((c) => c.id), [3]);
  assert.equal(W.latestCapturedAt(caps), "2026-09-24T14:00:00.000Z");
  assert.equal(W.latestCapturedAt([]), null);
});
