import assert from "node:assert/strict";
import { test } from "node:test";
import { AnswerDraft, endAnswer, followAnswer, keptAnswers, publishAnswer } from "../server/stream.ts";

const say = (text, messageId) => ({ type: "assistant_message", text, messageId });

test("deltas add up to the answer", () => {
  const draft = new AnswerDraft();
  draft.add(say("멱등성은 "));
  draft.add(say("같은 요청을 "));
  draft.add(say("여러 번 보내도 결과가 같다는 뜻이다."));
  assert.equal(draft.text, "멱등성은 같은 요청을 여러 번 보내도 결과가 같다는 뜻이다.");
});

test("a chunk repeating the text so far replaces it", () => {
  const draft = new AnswerDraft();
  draft.add(say("멱등성은 "));
  draft.add(say("멱등성은 같은 결과를 낸다."));
  assert.equal(draft.text, "멱등성은 같은 결과를 낸다.");
});

test("text written before a tool call is dropped", () => {
  const draft = new AnswerDraft();
  draft.add(say("파일을 읽어 보겠다."));
  assert.equal(draft.add({ type: "tool_call", name: "Read" }), false);
  draft.add(say("답이다."));
  assert.equal(draft.text, "답이다.");
});

test("a new message ID starts a new answer", () => {
  const draft = new AnswerDraft();
  draft.add(say("앞", "m1"));
  draft.add(say("뒤", "m2"));
  assert.equal(draft.text, "뒤");
});

test("reasoning is not part of the answer", () => {
  const draft = new AnswerDraft();
  assert.equal(draft.add({ type: "reasoning", text: "생각" }), false);
  assert.equal(draft.text, "");
});

test("a follower gets the text so far and every change, then the text is dropped", () => {
  publishAnswer("r1", "앞");
  const seen = [];
  const stop = followAnswer("r1", (text) => seen.push(text));
  publishAnswer("r1", "앞뒤");
  endAnswer("r1");
  assert.deepEqual(seen, ["앞", "앞뒤"]);
  assert.equal(keptAnswers(), 1);
  stop();
  assert.equal(keptAnswers(), 0);
});

test("a follower may arrive before the request starts", () => {
  const seen = [];
  const stop = followAnswer("r2", (text) => seen.push(text));
  publishAnswer("r2", "답");
  stop();
  assert.equal(keptAnswers(), 1);
  endAnswer("r2");
  assert.equal(keptAnswers(), 0);
  assert.deepEqual(seen, ["답"]);
});
