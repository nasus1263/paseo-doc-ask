import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addFootnote,
  buildFootnote,
  findBlockEnd,
  fromSuperscript,
  highlightRange,
  keptLength,
  locateRendered,
  locateSelection,
  nextFootnoteLabel,
  prepareFootnotes,
  referenceOffset,
} from "../shared/markdown.ts";

test("locateSelection keeps original offsets when text is unchanged", () => {
  assert.deepEqual(locateSelection("abc def", { from: 4, to: 7 }, "def"), { from: 4, to: 7 });
});

test("locateSelection follows a shifted passage to its nearest occurrence", () => {
  const text = "xx def ... def";
  assert.deepEqual(locateSelection(text, { from: 12, to: 15 }, "def"), { from: 11, to: 14 });
  assert.equal(locateSelection(text, { from: 0, to: 3 }, "zzz"), null);
});

test("findBlockEnd skips blank lines inside fenced code", () => {
  const text = "```\na\n\nb\n```\nafter";
  assert.equal(findBlockEnd(text, 5), text.indexOf("after"));
});

test("locateRendered maps rendered text across markup, links and footnote references", () => {
  const source = "# 제목\n\n이것은 **멱등성**[^1](idempotency)과 [재시도 큐](https://x.y/z)다.\n";
  const found = locateRendered(source, "멱등성¹(idempotency)과 재시도 큐");
  assert.equal(source.slice(found.from, found.to), "멱등성**[^1](idempotency)과 [재시도 큐");
  assert.equal(locateRendered(source, "없는 문장"), null);
});

test("locateRendered prefers the occurrence nearest the rendered prefix", () => {
  const source = "- 큐 하나\n- 둘\n\n세 번째 큐\n";
  const found = locateRendered(source, "큐", keptLength("• 큐 하나\n• 둘\n세 번째 "));
  assert.equal(found.from, source.lastIndexOf("큐"));
});

test("referenceOffset steps past emphasis, inline code and link targets", () => {
  assert.equal(referenceOffset("a **bold** b", 8), 10);
  assert.equal(referenceOffset("use `foo bar` now", 8), 13);
  assert.equal(referenceOffset("see [docs](http://x) ok", 9), 20);
  assert.equal(referenceOffset("word  \n", 7), 4);
  assert.equal(referenceOffset("```\ncode\n```", 6), null);
});

test("nextFootnoteLabel picks the next number", () => {
  assert.equal(nextFootnoteLabel("no notes"), "1");
  assert.equal(nextFootnoteLabel("a[^2] b[^note]\n\n[^2]: x"), "3");
});

test("buildFootnote indents the answer under a bold title", () => {
  assert.equal(
    buildFootnote("1", "설명", "멱등성", "한 줄\n\n두 문단"),
    "[^1]: **설명: 멱등성**\n\n    한 줄\n\n    두 문단",
  );
});

test("addFootnote references the selection and appends the definition", () => {
  const text = "# T\n\nAlpha **beta** gamma.\n\nNext.\n";
  const from = text.indexOf("beta");
  assert.equal(
    addFootnote(text, { from, to: from + 4 }, "질문", "왜?", "답"),
    "# T\n\nAlpha **==beta==**[^1] gamma.\n\nNext.\n\n[^1]: **질문: 왜?**\n\n    답\n",
  );
});

test("addFootnote skips the highlight when the selection spans lines", () => {
  const text = "one\ntwo";
  assert.equal(
    addFootnote(text, { from: 0, to: 7 }, "설명", "x", "A"),
    "one\ntwo[^1]\n\n[^1]: **설명: x**\n\n    A\n",
  );
});

test("highlightRange widens over markup to keep delimiters balanced", () => {
  const text = "이것은 **멱등성**(idempotency)과 [재시도 큐](https://x.y/z)다.";
  const slice = (range) => (range ? text.slice(range.from, range.to) : null);
  const at = (s) => ({ from: text.indexOf(s), to: text.indexOf(s) + s.length });
  assert.equal(slice(highlightRange(text, at("멱등성"))), "멱등성");
  assert.equal(slice(highlightRange(text, at("멱등성**(idempotency)"))), "**멱등성**(idempotency)");
  assert.equal(slice(highlightRange(text, at("과 [재시도 큐"))), "과 [재시도 큐](https://x.y/z)");
  assert.equal(highlightRange("```\ncode\n```", { from: 4, to: 8 }), null);
});

test("addFootnote gives a reference inside fenced code its own paragraph", () => {
  const text = "```\ncode\n```\nafter";
  assert.equal(
    addFootnote(text, { from: 4, to: 8 }, "설명", "code", "A"),
    "```\ncode\n```\n\n[^1]\n\nafter\n\n[^1]: **설명: code**\n\n    A\n",
  );
});

test("prepareFootnotes renders references as superscripts and collects notes", () => {
  const text = [
    "One[^b] two[^a][^b] `x[^a]`.",
    "",
    "[^a]: **A**",
    "",
    "    body a",
    "[^b]: B",
    "[^z]: unused",
  ].join("\n");
  const { body, notes } = prepareFootnotes(text);
  assert.equal(body, "One¹ two²,¹ `x[^a]`.");
  assert.deepEqual(notes, [
    { label: "b", number: 1, content: "B" },
    { label: "a", number: 2, content: "**A**\n\nbody a" },
    { label: "z", number: 3, content: "unused" },
  ]);
  assert.equal(fromSuperscript("¹²"), 12);
  assert.ok(Number.isNaN(fromSuperscript("1")));
});

test("prepareFootnotes unwraps highlights and links them to their footnotes", () => {
  const text = "A ==멱등성==[^1] and ==plain== but `==code==`.\n\n[^1]: note";
  const { body, marks } = prepareFootnotes(text);
  assert.equal(body, "A 멱등성¹ and plain but `==code==`.");
  assert.deepEqual(marks, [
    { text: "멱등성", number: 1 },
    { text: "plain", number: null },
  ]);
});
