import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestOccurrence, removeTempNote, tempNotesFileName, upsertTempNote } from "../shared/temp-notes.ts";

const note = (id, input) => ({ id, scope: "", text: "a", hint: 0, input, updatedAt: 0 });

test("upsert replaces by id or appends", () => {
  const list = upsertTempNote([note("x", "1")], note("y", "2"));
  assert.deepEqual(list.map((n) => n.id), ["x", "y"]);
  assert.equal(upsertTempNote(list, note("x", "3"))[0].input, "3");
  assert.deepEqual(removeTempNote(list, "x").map((n) => n.id), ["y"]);
});

test("nearest occurrence picks the repeat closest to the hint", () => {
  assert.equal(nearestOccurrence("abcabcabc", "abc", 5), 6);
  assert.equal(nearestOccurrence("abcabcabc", "abc", 0), 0);
  assert.equal(nearestOccurrence("abc", "x", 0), -1);
  assert.equal(nearestOccurrence("abc", "", 0), -1);
});

test("file names are stable and distinct", () => {
  assert.equal(tempNotesFileName("doc:a.md"), tempNotesFileName("doc:a.md"));
  assert.notEqual(tempNotesFileName("doc:a.md"), tempNotesFileName("doc:b.md"));
  assert.match(tempNotesFileName("agent:1"), /^[0-9a-f]{16}\.json$/);
});
