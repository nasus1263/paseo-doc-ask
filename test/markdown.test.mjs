import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotate,
  appendToFootnote,
  splitTitle,
  commentPathOf,
  definesFootnote,
  buildFootnote,
  findBlockEnd,
  fromSuperscript,
  highlightRange,
  keptLength,
  locateRendered,
  listBookmarks,
  locateSelection,
  nextFootnoteLabel,
  prepareFootnotes,
  referenceOffset,
  removeFootnote,
  setNoteMeta,
  splitFollowUps,
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


test("annotate highlights and references in the document, defines in the comment file", () => {
  const doc = "# T\n\nAlpha **beta** gamma.\n\nNext.\n";
  const from = doc.indexOf("beta");
  assert.deepEqual(annotate(doc, "", { from, to: from + 4 }, "질문", "왜?", "답"), {
    doc: "# T\n\nAlpha ==**beta**==[^1] gamma.\n\nNext.\n",
    comments: "[^1]: **질문: 왜?**\n\n    답\n",
    id: "1",
    replaced: [],
  });
});

test("annotate replaces an overlapping annotation", () => {
  const doc = "x ==ab==[^1]cdefgh y\n";
  const comments = "[^1]: **설명: ab**\n\n    old\n\n[^2]: **설명: z**\n\n    keep\n";
  // The user selects "bcd" in the rendered text.
  const from = doc.indexOf("b==");
  const to = doc.indexOf("d") + 1;
  assert.deepEqual(annotate(doc, comments, { from, to }, "설명", "bcd", "new"), {
    doc: "x a==bcd==[^3]efgh y\n",
    comments: "[^2]: **설명: z**\n\n    keep\n\n[^3]: **설명: bcd**\n\n    new\n",
    id: "3",
    replaced: ["1"],
  });
});

test("annotate replaces a bare reference inside the selection", () => {
  const doc = "abc[^3]def\n";
  const comments = "[^3]: **설명: c**\n\n    old\n";
  const to = doc.indexOf("d") + 1;
  const { doc: next, comments: notes, replaced } = annotate(doc, comments, { from: 1, to }, "설명", "bcd", "A");
  assert.equal(next, "a==bcd==[^1]ef\n");
  assert.equal(notes, "[^1]: **설명: bcd**\n\n    A\n");
  assert.deepEqual(replaced, ["3"]);
});

test("annotate numbers past labels in both files and appends to existing comments", () => {
  const doc = "a ==x==[^1] b\n";
  const comments = "[^1]: **설명: x**\n\n    old\n";
  const from = doc.indexOf("b");
  assert.deepEqual(annotate(doc, comments, { from, to: from + 1 }, "설명", "b", "new"), {
    doc: "a ==x==[^1] ==b==[^2]\n",
    comments: "[^1]: **설명: x**\n\n    old\n\n[^2]: **설명: b**\n\n    new\n",
    id: "2",
    replaced: [],
  });
});

test("annotate skips the highlight across lines and gives fenced code its own reference", () => {
  assert.equal(annotate("one\ntwo", "", { from: 0, to: 7 }, "설명", "x", "A").doc, "one\ntwo[^1]");
  assert.equal(
    annotate("```\ncode\n```\nafter", "", { from: 4, to: 8 }, "설명", "code", "A").doc,
    "```\ncode\n```\n\n[^1]\n\nafter",
  );
});

test("commentPathOf names the companion file", () => {
  assert.equal(commentPathOf("C:/docs/plan.md"), "C:/docs/plan.comment.md");
  assert.equal(commentPathOf("/a/b.MARKDOWN"), "/a/b.comment.md");
  assert.equal(commentPathOf("/a/b.comment.md"), null);
  assert.equal(commentPathOf("/a/b.txt"), null);
});

test("highlightRange keeps touching markup inside the highlight", () => {
  const text = "이것은 **멱등성**(idempotency)과 [재시도 큐](https://x.y/z)다. 저장 `Zones` 목록, **굵은 글 일부**";
  const slice = (range) => (range ? text.slice(range.from, range.to) : null);
  const at = (s) => ({ from: text.indexOf(s), to: text.indexOf(s) + s.length });
  assert.equal(slice(highlightRange(text, at("멱등성"))), "**멱등성**");
  assert.equal(slice(highlightRange(text, at("Zones"))), "`Zones`");
  assert.equal(slice(highlightRange(text, at("Zon"))), "`Zones`");
  assert.equal(slice(highlightRange(text, at("글"))), "글");
  assert.equal(slice(highlightRange(text, at("멱등성**(idempotency)"))), "**멱등성**(idempotency)");
  assert.equal(slice(highlightRange(text, at("과 [재시도 큐"))), "과 [재시도 큐](https://x.y/z)");
  assert.equal(highlightRange("```\ncode\n```", { from: 4, to: 8 }), null);
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
    { label: "b", number: 1, content: "B", meta: {} },
    { label: "a", number: 2, content: "**A**\n\nbody a", meta: {} },
    { label: "z", number: 3, content: "unused", meta: {} },
  ]);
  assert.equal(fromSuperscript("¹²"), 12);
  assert.ok(Number.isNaN(fromSuperscript("1")));
});

test("prepareFootnotes wraps highlights in sentinels and links them to their footnotes", () => {
  const text = "A ==멱등성==[^1] and ==a = b== but `x == y` and ==`code`==.";
  const { body, marks, notes } = prepareFootnotes(text, "# 주석\n\n[^1]: note");
  assert.equal(body, "A ⁣멱등성⁤ and ⁣a = b⁤ but `x == y` and ⁣`code`⁤.");
  assert.deepEqual(marks, [
    { text: "멱등성", number: 1 },
    { text: "a = b", number: null },
    { text: "`code`", number: null },
  ]);
  assert.deepEqual(notes, [{ label: "1", number: 1, content: "note", meta: {} }]);
});

test("prepareFootnotes shows older highlights written inside code or emphasis outside it", () => {
  const { body } = prepareFootnotes("저장 `==Zones==` 목록, **==P3 = 최적==**[^1]", "[^1]: n");
  assert.equal(body, "저장 ⁣`Zones`⁤ 목록, ⁣**P3 = 최적**⁤");
});

test("prepareFootnotes prefers the document's own definition over the comment file", () => {
  const { notes } = prepareFootnotes("x[^1]\n\n[^1]: mine", "[^1]: theirs");
  assert.equal(notes[0].content, "mine");
});

test("appendToFootnote accumulates follow-ups inside the same footnote", () => {
  const comments = "[^1]: **설명: x**\n\n    first\n\n    second\n\n[^2]: **설명: y**\n\n    other\n";
  const next = appendToFootnote(comments, "1", "질문", "왜?", "답 1\n\n답 2");
  assert.equal(
    next,
    "[^1]: **설명: x**\n\n    first\n\n    second\n\n    **질문: 왜?**\n\n    답 1\n\n    답 2\n\n[^2]: **설명: y**\n\n    other\n",
  );
  const { notes } = prepareFootnotes("a[^1] b[^2]", next);
  assert.equal(notes[0].content, "**설명: x**\n\nfirst\n\nsecond\n\n**질문: 왜?**\n\n답 1\n\n답 2");
  assert.equal(notes[1].content, "**설명: y**\n\nother");
  assert.equal(appendToFootnote(comments, "9", "설명", "z", "A"), null);
  assert.ok(definesFootnote(comments, "2"));
  assert.ok(!definesFootnote(comments, "3"));
});

test("a follow-up on a passage of the footnote quotes that passage under its heading", () => {
  const comments = "[^1]: **설명: x**\n\n    first\n";
  const next = appendToFootnote(comments, "1", "질문", "왜?", "답", "first 의\n일부");
  assert.equal(next, "[^1]: **설명: x**\n\n    first\n\n    **질문: 왜?**\n\n    > first 의\n    > 일부\n\n    답\n");
});

test("splitFollowUps separates the original note from each follow-up", () => {
  const content = "**설명: x**\n\nfirst\n\n**질문: 왜?**\n\n> first\n\n답 1\n\n**설명: y**\n\n답 2";
  assert.deepEqual(splitFollowUps(content), [
    "**설명: x**\n\nfirst",
    "**질문: 왜?**\n\n> first\n\n답 1",
    "**설명: y**\n\n답 2",
  ]);
  assert.deepEqual(splitFollowUps("**지시: x**\n\n그냥 **질문: 아님**"), ["**지시: x**\n\n그냥 **질문: 아님**"]);
});

test("annotate reports the new footnote label", () => {
  assert.equal(annotate("a b", "[^4]: x", { from: 2, to: 3 }, "설명", "b", "A").id, "5");
});

test("setNoteMeta stores bookmark and memo on the definition line, hidden from content", () => {
  const comments = "[^1]: **설명: x**\n\n    body\n\n[^2]: **설명: y**\n\n    other\n";
  const marked = setNoteMeta(comments, "1", { bookmark: true, memo: "a --> b\n둘째 줄" });
  assert.ok(marked.startsWith("[^1]: **설명: x** <!-- doc-ask {"));
  assert.ok(!marked.split("\n")[0].slice(0, -4).includes("-->"), "memo cannot close the comment early");
  const { notes } = prepareFootnotes("a[^1] b[^2]", marked);
  assert.deepEqual(notes[0].meta, { bookmark: true, memo: "a --> b\n둘째 줄" });
  assert.equal(notes[0].content, "**설명: x**\n\nbody");
  assert.deepEqual(notes[1].meta, {});
  assert.deepEqual(listBookmarks(marked), [
    { label: "1", title: "설명: x", memo: "a --> b\n둘째 줄", content: "**설명: x**\n\nbody" },
  ]);
  // Clearing everything removes the comment.
  assert.equal(setNoteMeta(marked, "1", { bookmark: false, memo: " " }), comments);
  assert.equal(setNoteMeta(comments, "9", { bookmark: true }), null);
});

test("removeFootnote drops the highlight, every reference and the definition", () => {
  const doc = "a ==x==[^1] b[^2] c[^1]\n";
  const comments = "[^1]: **설명: x** <!-- doc-ask {\"bookmark\":true} -->\n\n    old\n\n[^2]: **설명: b**\n\n    keep\n";
  assert.deepEqual(removeFootnote(doc, comments, "1"), {
    doc: "a x b[^2] c\n",
    comments: "[^2]: **설명: b**\n\n    keep\n",
    found: true,
  });
  assert.equal(removeFootnote(doc, comments, "9").found, false);
});

test("a document comment keeps overlapping notes and adds only a reference there", () => {
  const doc = "x ==abc==[^1] y\n";
  const comments = "[^1]: **설명: abc**\n\n    old\n";
  const from = doc.indexOf("b");
  const result = annotate(doc, comments, { from, to: from + 1 }, "주석", "b", "내 생각", { comment: true });
  assert.deepEqual(result.replaced, []);
  assert.equal(result.doc, "x ==ab[^2]c==[^1] y\n");
  const { notes } = prepareFootnotes(result.doc, result.comments);
  assert.deepEqual(
    notes.map((n) => [n.label, n.meta.comment === true]),
    [["2", true], ["1", false]],
  );
});

test("a document comment on free text is highlighted and marked as a comment", () => {
  const result = annotate("hello world\n", "", { from: 6, to: 11 }, "주석", "world", "좋다", { comment: true });
  assert.equal(result.doc, "hello ==world==[^1]\n");
  assert.match(result.comments, /^\[\^1\]: \*\*주석: world\*\* <!-- doc-ask \{"comment":true\} -->/);
});

test("splitTitle separates a unit's kind and subject from its body", () => {
  assert.deepEqual(splitTitle("**설명: 낙하**\n\n본문"), { kind: "설명", subject: "낙하", body: "본문" });
  assert.deepEqual(splitTitle("**지시: a: b**"), { kind: "지시", subject: "a: b", body: "" });
  assert.equal(splitTitle("**메모: x**\n\n본문"), null);
  assert.equal(splitTitle("본문만"), null);
});
