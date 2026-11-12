import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAt, anchorRange, annotateChat, chatMarks, chatNotes, messageKey } from "../shared/chat.ts";
import { setNoteMeta } from "../shared/markdown.ts";

test("messageKey prefers the id and hashes text otherwise", () => {
  assert.equal(messageKey("m1", "x"), "m1");
  assert.equal(messageKey(null, "같은 글"), messageKey(undefined, "같은 글"));
  assert.notEqual(messageKey(null, "a"), messageKey(null, "b"));
});

test("anchors point at the nth occurrence of a passage", () => {
  const text = "큐 하나, 큐 둘, 큐 셋";
  const range = { from: text.lastIndexOf("큐"), to: text.lastIndexOf("큐") + 1 };
  const anchor = anchorAt("m", text, range);
  assert.deepEqual(anchor, { message: "m", quote: "큐", occurrence: 2 });
  assert.deepEqual(anchorRange(text, anchor), range);
  assert.equal(anchorRange(text, { ...anchor, occurrence: 5 }), null);
});

test("annotateChat stores the anchor and chatMarks highlights only that message", () => {
  const text = "멱등성은 중요하다. 멱등성!";
  const from = text.lastIndexOf("멱등성");
  const first = annotateChat("", text, "m1", { from, to: from + 3 }, "설명", "멱등성", "답");
  assert.equal(first.id, "1");
  const [note] = chatNotes(first.comments);
  assert.deepEqual(note.meta.anchor, { message: "m1", quote: "멱등성", occurrence: 1 });
  assert.equal(note.content, "**설명: 멱등성**\n\n답");

  const { body, marks } = chatMarks(text, "m1", chatNotes(first.comments));
  assert.equal(body, "멱등성은 중요하다. ⁣멱등성⁤¹!");
  assert.deepEqual(marks, [{ text: "멱등성", number: 1 }]);
  assert.equal(chatMarks(text, "other", chatNotes(first.comments)).body, text);
});

test("annotateChat replaces overlapping notes on the same message only", () => {
  const text = "abcdefgh";
  let comments = annotateChat("", text, "m1", { from: 0, to: 2 }, "설명", "ab", "A").comments;
  comments = annotateChat(comments, "zz", "m2", { from: 0, to: 2 }, "설명", "zz", "Z").comments;
  const next = annotateChat(comments, text, "m1", { from: 1, to: 4 }, "설명", "bcd", "B");
  assert.deepEqual(next.replaced, ["1"]);
  assert.deepEqual(
    chatNotes(next.comments).map((n) => [n.label, n.meta.anchor?.message]),
    [["2", "m2"], ["3", "m1"]],
  );
});

test("bookmark and memo keep the anchor", () => {
  const { comments } = annotateChat("", "hello", "m", { from: 0, to: 5 }, "설명", "hello", "A");
  const marked = setNoteMeta(comments, "1", { ...chatNotes(comments)[0].meta, bookmark: true });
  assert.deepEqual(chatNotes(marked)[0].meta, {
    bookmark: true,
    anchor: { message: "m", quote: "hello", occurrence: 0 },
  });
});
