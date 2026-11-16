import assert from "node:assert/strict";
import { test } from "node:test";
import { runDeciding } from "../server/permissions.ts";
import { askingUser } from "../server/explainer.ts";
import { PermissionPrompts } from "../server/prompts.ts";

/** Prompts no app listens to: every non-read tool is denied. */
const readOnly = askingUser("a", new PermissionPrompts());

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

test("askingUser allows read tools and denies the rest when no app listens", async () => {
  for (const name of ["Read", "Grep", "Glob", "LS"]) assert.equal((await readOnly({ id: "1", name })).behavior, "allow");
  for (const name of ["Bash", "Edit", "Write", "WebFetch"]) assert.equal((await readOnly({ id: "1", name })).behavior, "deny");
});

test("askingUser follows the user's answer", async () => {
  const prompts = new PermissionPrompts();
  const seen = [];
  prompts.listen((list) => seen.push(list));
  const decide = askingUser("a", prompts);
  const allowed = decide({ id: "1", name: "Bash", description: "ls" });
  const denied = decide({ id: "2", name: "Edit" });
  assert.deepEqual(seen.at(-1).map((p) => [p.id, p.tool, p.detail]), [["a:1", "Bash", "ls"], ["a:2", "Edit", ""]]);
  assert.equal(prompts.respond("a:1", true), true);
  assert.equal(prompts.respond("a:2", false), true);
  assert.equal(prompts.respond("a:2", true), false);
  assert.equal((await allowed).behavior, "allow");
  assert.equal((await denied).behavior, "deny");
  assert.deepEqual(seen.at(-1), []);
});

test("PermissionPrompts denies what waits when the last app leaves or time runs out", async () => {
  const prompts = new PermissionPrompts(20);
  const stop = prompts.listen(() => {});
  const left = prompts.ask({ id: "x", agentId: "a", tool: "Bash", title: null, detail: "" });
  stop();
  assert.equal(await left, false);
  prompts.listen(() => {});
  assert.equal(await prompts.ask({ id: "y", agentId: "a", tool: "Bash", title: null, detail: "" }), false);
});
