import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCallout,
  findBlockEnd,
  insertAnswer,
  keptLength,
  locateRendered,
  locateSelection,
} from "../shared/markdown.ts";

test("locateSelection keeps original offsets when text is unchanged", () => {
  assert.deepEqual(locateSelection("abc def", { from: 4, to: 7 }, "def"), { from: 4, to: 7 });
});

test("locateSelection follows a shifted passage to its nearest occurrence", () => {
  const text = "xx def ... def";
  assert.deepEqual(locateSelection(text, { from: 12, to: 15 }, "def"), { from: 11, to: 14 });
  assert.equal(locateSelection(text, { from: 0, to: 3 }, "zzz"), null);
});

test("findBlockEnd stops at the blank line after the paragraph", () => {
  const text = "# T\n\nline one\nline two\n\nnext";
  const end = text.indexOf("one") + 3;
  assert.equal(findBlockEnd(text, end), text.indexOf("\n\nnext") + 1);
});

test("findBlockEnd skips blank lines inside fenced code", () => {
  const text = "```\na\n\nb\n```\nafter";
  assert.equal(findBlockEnd(text, 5), text.indexOf("after"));
});

test("insertAnswer places a callout after the paragraph", () => {
  const text = "# T\n\nAlpha beta.\nGamma.\n\nNext para.\n";
  const from = text.indexOf("beta");
  const out = insertAnswer(text, { from, to: from + 4 }, "beta", "설명 1\n\n설명 2");
  assert.equal(
    out,
    "# T\n\nAlpha beta.\nGamma.\n\n> [!note] 질문: beta\n>\n> 설명 1\n>\n> 설명 2\n\nNext para.\n",
  );
});

test("insertAnswer appends at end of document", () => {
  const text = "only line";
  assert.equal(insertAnswer(text, { from: 0, to: 4 }, "only", "A"), "only line\n\n> [!note] 질문: only\n>\n> A\n");
});

test("locateRendered maps rendered text across markup and link targets", () => {
  const source = "# 제목\n\n이것은 **멱등성**(idempotency)과 [재시도 큐](https://x.y/z)다.\n";
  const found = locateRendered(source, "멱등성(idempotency)과 재시도 큐");
  assert.equal(source.slice(found.from, found.to), "멱등성**(idempotency)과 [재시도 큐");
  assert.equal(locateRendered(source, "없는 문장"), null);
});

test("locateRendered prefers the occurrence nearest the rendered prefix", () => {
  const source = "- 큐 하나\n- 둘\n\n세 번째 큐\n";
  const rendered = "• 큐 하나\n• 둘\n세 번째 ";
  const found = locateRendered(source, "큐", keptLength(rendered));
  assert.equal(found.from, source.lastIndexOf("큐"));
});

test("buildCallout truncates long titles and flattens whitespace", () => {
  const head = buildCallout("a\n".repeat(50), "x").split("\n")[0];
  assert.equal(head, `> [!note] 질문: ${"a ".repeat(30)}…`);
});
