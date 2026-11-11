import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatches, stepMatch } from "../shared/search.ts";

test("finds non-overlapping case-insensitive matches", () => {
  assert.deepEqual(findMatches("Foo foo FOO", "foo"), [
    { from: 0, to: 3 },
    { from: 4, to: 7 },
    { from: 8, to: 11 },
  ]);
  assert.deepEqual(findMatches("aaaa", "aa"), [
    { from: 0, to: 2 },
    { from: 2, to: 4 },
  ]);
  assert.deepEqual(findMatches("멱등성과 멱등", "멱등"), [
    { from: 0, to: 2 },
    { from: 5, to: 7 },
  ]);
  assert.deepEqual(findMatches("text", ""), []);
});

test("steps through matches with wrap-around", () => {
  assert.equal(stepMatch(0, 3, 1), 1);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(7, 3, 1), 0); // a stale index past the end counts from the last match
  assert.equal(stepMatch(0, 0, 1), 0);
});
