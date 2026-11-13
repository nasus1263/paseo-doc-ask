import assert from "node:assert/strict";
import { test } from "node:test";
import { runDeciding } from "../server/permissions.ts";
import { readOnly } from "../server/explainer.ts";

/** A fake agent whose turn raises the given batches of permission requests, one batch per round. */
function fakeAgent(batches) {
  const responses = [];
  let round = 0;
  const settle = () => (round < batches.length ? { status: "permission" } : { status: "idle", lastMessage: "답" });
  return {
    responses,
    pendingPermissions: [],
    async run() {
      return settle();
    },
    async refresh() {
      this.pendingPermissions = batches[round] ?? [];
    },
    async respondToPermission(answer) {
      responses.push(answer);
    },
    async waitForFinish() {
      round++;
      return settle();
    },
  };
}

test("runDeciding answers every request until the turn settles", async () => {
  const agent = fakeAgent([[{ id: "1", name: "Read" }], [{ id: "2", name: "Bash" }, { id: "3", name: "Grep" }]]);
  const result = await runDeciding(agent, "q", 1000, readOnly);
  assert.equal(result.status, "idle");
  assert.deepEqual(
    agent.responses.map((r) => [r.requestId, r.response.behavior]),
    [["1", "allow"], ["2", "deny"], ["3", "allow"]],
  );
});

test("runDeciding returns a turn without permission requests untouched", async () => {
  const agent = fakeAgent([]);
  assert.equal((await runDeciding(agent, "q", 1000, readOnly)).status, "idle");
  assert.equal(agent.responses.length, 0);
});

test("readOnly allows read tools only", () => {
  for (const name of ["Read", "Grep", "Glob", "LS"]) assert.equal(readOnly({ name }).behavior, "allow");
  for (const name of ["Bash", "Edit", "Write", "WebFetch"]) assert.equal(readOnly({ name }).behavior, "deny");
});
