import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedGitCommand, shellWords } from "../server/git-policy.ts";

test("shellWords honors quotes", () => {
  assert.deepEqual(shellWords(`git commit -m "a b" 'c d'`), ["git", "commit", "-m", "a b", "c d"]);
  assert.equal(shellWords(`git commit -m "open`), null);
});

test("read-only git commands are allowed, also with -C", () => {
  for (const command of [
    "git status",
    "git -C \"C:/a b/repo\" diff --cached",
    "git diff -- docs/a.md",
    "git log --oneline -3",
    "git show HEAD:docs/a.md",
    "git rev-parse --show-toplevel",
  ]) {
    assert.ok(isAllowedGitCommand(command), command);
  }
});

test("staging goes only through git apply --cached, heredoc included", () => {
  assert.ok(isAllowedGitCommand("git apply --cached - <<'PATCH'\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a; rm -rf /\n+b\nPATCH"));
  assert.ok(!isAllowedGitCommand("git apply - <<'PATCH'\nx\nPATCH"));
  assert.ok(!isAllowedGitCommand("git apply --cached --index p.patch"));
  assert.ok(!isAllowedGitCommand("git apply --cached - <<'PATCH'\nx\nNOPE"));
  assert.ok(!isAllowedGitCommand("git add docs/a.md"));
  assert.ok(!isAllowedGitCommand("git add -A"));
  assert.ok(!isAllowedGitCommand("git add -f docs/a.comment.md"));
});

test("git add is allowed only for comment files", () => {
  assert.ok(isAllowedGitCommand("git add docs/a.comment.md"));
  assert.ok(isAllowedGitCommand('git -C repo add -- "docs/my plan.comment.md"'));
  assert.ok(!isAllowedGitCommand("git add docs/a.comment.md docs/a.md"));
  assert.ok(!isAllowedGitCommand("git add"));
});

test("commits record only the index", () => {
  assert.ok(isAllowedGitCommand(`git commit -m "문서에 각주 추가"`));
  assert.ok(isAllowedGitCommand("git -C repo commit -F - <<'MSG'\n제목\n\n본문\nMSG"));
  for (const command of [
    "git commit -am x",
    "git commit -a -m x",
    "git commit --amend -m x",
    "git commit --no-verify -m x",
    "git commit -m x docs/a.md",
    "git commit -m x -- docs/a.md",
  ]) {
    assert.ok(!isAllowedGitCommand(command), command);
  }
});

test("chaining, redirection, and other programs are refused", () => {
  for (const command of [
    "git status && git push",
    "git status; rm x",
    "git diff > out.patch",
    "git log | head",
    "git show $(echo HEAD)",
    "git push",
    "git reset --hard",
    "git checkout -- docs/a.md",
    "cd repo",
    "echo hi",
  ]) {
    assert.ok(!isAllowedGitCommand(command), command);
  }
});
