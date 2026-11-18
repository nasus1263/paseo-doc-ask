import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAt, anchorRange, annotateChat, answerAges, chatMarks, chatNotes, copyComments, messageKey, markSent, unsentComments } from "../shared/chat.ts";
import { setNoteMeta } from "../shared/markdown.ts";

test("messageKey hashes the text, ignoring surrounding whitespace", () => {
  assert.equal(messageKey("같은 글"), messageKey("\n같은 글\n"));
  assert.notEqual(messageKey("a"), messageKey("b"));
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
  assert.equal(note.passage, "멱등성");
  assert.equal(note.content, "**설명: 멱등성**\n\n답");

  const { body, marks } = chatMarks(text, "m1", chatNotes(first.comments));
  assert.equal(body, "멱등성은 중요하다. ⁣멱등성⁤!");
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

test("a comment keeps overlapping notes and both stay reachable", () => {
  const text = "멱등성은 중요하다.";
  const explained = annotateChat("", text, "m", { from: 0, to: 3 }, "설명", "멱등성", "AI 설명");
  const commented = annotateChat(explained.comments, text, "m", { from: 0, to: 9 }, "주석", "멱등성은 중요하다", "동의함", {
    comment: true,
  });
  assert.deepEqual(commented.replaced, []);
  const notes = chatNotes(commented.comments);
  assert.deepEqual(notes.map((n) => [n.label, n.meta.comment === true]), [["1", false], ["2", true]]);
  const { body, marks } = chatMarks(text, "m", notes);
  // The explanation keeps its yellow highlight, without a number; the instruction is painted on its own,
  // overlapping it, with no number.
  assert.equal(body, "⁡⁣멱등성⁤은 중요하다⁢.");
  assert.deepEqual(marks, [
    { text: "멱등성", number: 1 },
    { text: "멱등성은 중요하다", number: 2, comment: true },
  ]);
});

test("a highlight and an instruction ending at the same place add no number", () => {
  const text = "abc";
  let comments = annotateChat("", text, "m", { from: 0, to: 3 }, "설명", "abc", "A").comments;
  comments = annotateChat(comments, text, "m", { from: 1, to: 3 }, "설명", "bc", "B").comments;
  comments = annotateChat(comments, text, "m", { from: 2, to: 3 }, "지시", "c", "C", { comment: true }).comments;
  // "bc" replaced "abc" as footnote 1; the instruction ending at the same place adds no number.
  assert.equal(chatMarks(text, "m", chatNotes(comments)).body, "a⁣b⁡c⁤⁢");
});

test("explanations are numbered first and instructions after them", () => {
  const text = "abcdef";
  let comments = annotateChat("", text, "m", { from: 0, to: 2 }, "지시", "ab", "A", { comment: true }).comments;
  comments = annotateChat(comments, text, "m", { from: 3, to: 5 }, "설명", "de", "D").comments;
  assert.deepEqual(
    chatNotes(comments).map((n) => [n.label, n.number]),
    [["2", 1], ["1", 2]],
  );
  assert.equal(chatMarks(text, "m", chatNotes(comments)).body, "⁡ab⁢c⁣de⁤f");
});

test("copyComments quotes each commented passage in order, comments only", () => {
  const text = "첫 문장.\n둘째 문장.";
  let comments = annotateChat("", text, "m", { from: 6, to: 12 }, "주석", "둘째 문장.", "두 번째 의견", { comment: true }).comments;
  comments = annotateChat(comments, text, "m", { from: 0, to: 2 }, "설명", "첫", "AI 설명").comments;
  comments = annotateChat(comments, text, "m", { from: 0, to: 5 }, "주석", "첫 문장.", "첫 의견\n\n둘째 줄", { comment: true }).comments;
  assert.equal(
    copyComments(text, "m", chatNotes(comments)),
    "> 첫 문장.\n\n첫 의견\n\n둘째 줄\n\n> 둘째 문장.\n\n두 번째 의견",
  );
  assert.equal(copyComments(text, "other", chatNotes(comments)), "");
});

test("unsentComments quotes only the reader's comments not sent yet, and markSent hides them", () => {
  const text = "멱등성은 중요하다. 캐시는 어렵다.";
  let comments = annotateChat("", text, "m", { from: 0, to: 3 }, "설명", "멱등성", "AI 설명").comments;
  comments = annotateChat(comments, text, "m", { from: 0, to: 3 }, "주석", "멱등성", "동의함", { comment: true }).comments;
  comments = annotateChat(comments, text, "m", { from: 11, to: 13 }, "주석", "캐시", "예시 필요", { comment: true }).comments;
  comments = annotateChat(comments, "다른 답", "other", { from: 0, to: 2 }, "주석", "다른", "무관", { comment: true }).comments;

  // "m" is the latest answer, "other" came three turns ago: oldest answer first.
  const answers = new Map([
    ["m", { text, turnsAgo: 1 }],
    ["other", { text: "다른 답", turnsAgo: 3 }],
  ]);
  const pending = unsentComments(chatNotes(comments), answers);
  assert.deepEqual(pending.labels, ["4", "2", "3"]);
  assert.deepEqual(pending.items, [
    { quote: "다른", comment: "무관", turnsAgo: 3 },
    { quote: "멱등성", comment: "동의함", turnsAgo: 1 },
    { quote: "캐시", comment: "예시 필요", turnsAgo: 1 },
  ]);
  assert.equal(
    pending.block,
    "### 3턴 전 답변\n\n> 다른\n\n무관\n\n### 직전 답변\n\n> 멱등성\n\n동의함\n\n> 캐시\n\n예시 필요",
  );

  // Only the ones not sent yet go next time.
  const partly = markSent(comments, ["2", "3"]);
  assert.deepEqual(unsentComments(chatNotes(partly), answers).labels, ["4"]);
  const sent = markSent(comments, pending.labels);
  assert.equal(unsentComments(chatNotes(sent), answers), null);
  // Sent comments keep their anchor and stay in the copy-all output.
  assert.equal(copyComments(text, "m", chatNotes(sent)), "> 멱등성\n\n동의함\n\n> 캐시\n\n예시 필요");
});

test("unsentComments sends comments on answers of unknown age first", () => {
  let comments = annotateChat("", "옛 답", "old", { from: 0, to: 1 }, "주석", "옛", "옛 지시", { comment: true }).comments;
  comments = annotateChat(comments, "새 답", "new", { from: 0, to: 1 }, "주석", "새", "새 지시", { comment: true }).comments;
  const pending = unsentComments(chatNotes(comments), new Map([["new", { text: "새 답", turnsAgo: 1 }]]));
  assert.equal(pending.block, "### 이전 답변(시점 확인 안 됨)\n\n> 옛\n\n옛 지시\n\n### 직전 답변\n\n> 새\n\n새 지시");
});

test("answerAges counts user messages after each answer", () => {
  const ages = answerAges([
    { type: "assistant_message", text: "A" },
    { type: "user_message", text: "q1" },
    { type: "assistant_message", text: "B" },
    { type: "tool_call" },
    { type: "assistant_message", text: "C" },
    { type: "user_message", text: "q2" },
    { type: "assistant_message", text: "D" },
  ]);
  assert.deepEqual(
    ["A", "B", "C", "D"].map((text) => ages.get(messageKey(text))),
    [3, 2, 2, 1],
  );
});

test("an empty comment sends only its quoted passage", () => {
  const comments = annotateChat("", "멱등성은 중요하다.", "m", { from: 0, to: 3 }, "지시", "멱등성", "", { comment: true }).comments;
  const pending = unsentComments(chatNotes(comments), new Map([["m", { text: "멱등성은 중요하다.", turnsAgo: 1 }]]));
  assert.deepEqual(pending.items, [{ quote: "멱등성", comment: "", turnsAgo: 1 }]);
  assert.equal(pending.block, "### 직전 답변\n\n> 멱등성");
});

test("unsentComments leaves out comments held back, until they are let go again", () => {
  const text = "멱등성은 중요하다. 캐시는 어렵다.";
  let comments = annotateChat("", text, "m", { from: 0, to: 3 }, "주석", "멱등성", "동의함", { comment: true }).comments;
  comments = annotateChat(comments, text, "m", { from: 11, to: 13 }, "주석", "캐시", "예시 필요", { comment: true }).comments;
  const answers = new Map([["m", { text, turnsAgo: 1 }]]);
  const meta = (label) => chatNotes(comments).find((note) => note.label === label).meta;

  comments = setNoteMeta(comments, "1", { ...meta("1"), excluded: true });
  assert.equal(meta("1").excluded, true);
  assert.deepEqual(unsentComments(chatNotes(comments), answers).labels, ["2"]);
  comments = setNoteMeta(comments, "2", { ...meta("2"), excluded: true });
  assert.equal(unsentComments(chatNotes(comments), answers), null);

  comments = setNoteMeta(comments, "1", { ...meta("1"), excluded: false });
  assert.equal(meta("1").excluded, undefined);
  assert.deepEqual(unsentComments(chatNotes(comments), answers).labels, ["1"]);
});

test("replaceFootnoteBody edits an instruction and keeps its follow-ups", async () => {
  const { replaceFootnoteBody, splitFollowUps, splitTitle } = await import("../shared/markdown.ts");
  const { chatNotes } = await import("../shared/chat.ts");
  const text = [
    "[^1]: **지시: 구절** <!-- doc-ask {\"comment\":true} -->",
    "",
    "    예전 지시",
    "",
    "    **질문: 왜**",
    "",
    "    답",
    "",
  ].join("\n");
  const next = replaceFootnoteBody(text, "1", "새 지시\n둘째 줄");
  const note = chatNotes(next)[0];
  const parts = splitFollowUps(note.content);
  assert.equal(splitTitle(parts[0]).body.trim(), "새 지시\n둘째 줄");
  assert.equal(parts.length, 2);
  assert.equal(note.meta.comment, true);
  assert.equal(chatNotes(replaceFootnoteBody(text, "1", "")).length, 1);
  assert.equal(replaceFootnoteBody(text, "9", "x"), null);
});
