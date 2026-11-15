import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { distinctPaths, extractLinkTokens, rewriteLinks } from "../shared/links.ts";
import { resolveLinks } from "../server/links.ts";

const slash = (path) => path.split(String.fromCharCode(92)).join("/");

test("a link relative to the document's folder opens through a workspace-relative href", async () => {
  const root = slash(mkdtempSync(join(tmpdir(), "doc-ask-links-")));
  mkdirSync(join(root, "docs/conventions/common"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  writeFileSync(join(root, "docs/conventions/assets.md"), "");
  writeFileSync(join(root, "docs/conventions/common/assets.md"), "");
  writeFileSync(join(root, "docs/conventions/only.md"), "");
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a/x.md"), "");
  writeFileSync(join(root, "other/x.md"), "");

  const text = [
    "넣는다([docs/conventions/assets.md](conventions/assets.md)).",
    "루트 기준 [a](docs/conventions/only.md), 이름만 [b](only.md), 여러 개 [c](x.md#L3).",
    "없음 [d](nowhere.md), 웹 [e](https://example.com/a.md).",
  ].join("\n");
  const tokens = extractLinkTokens(text);
  const paths = distinctPaths(tokens);
  const { results } = await resolveLinks({ bases: [`${root}/docs`, root], root, paths });
  const linked = rewriteLinks(text, tokens, new Map(paths.map((p, i) => [p, results[i]])), root);
  assert.equal(
    linked,
    [
      "넣는다([docs/conventions/assets.md](<docs/conventions/assets.md>)).",
      "루트 기준 [a](<docs/conventions/only.md>), 이름만 [b](<docs/conventions/only.md>), 여러 개 [c](<a/x.md#L3>).",
      "없음 [d](nowhere.md), 웹 [e](https://example.com/a.md).",
    ].join("\n"),
  );
});

test("a name shared by several files opens the one whose folders match the written path furthest up", async () => {
  const root = slash(mkdtempSync(join(tmpdir(), "doc-ask-links-")));
  for (const dir of ["idp-backend", "idp-frontend", "p/sub", "q"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ["idp-backend/.env", "idp-frontend/.env", "p/sub/a.md", "q/a.md"]) writeFileSync(join(root, file), "");

  const paths = ["idp/idp-backend/.env", "elsewhere/sub/a.md", "z/a.md"];
  const { results } = await resolveLinks({ bases: [root], root, paths });
  assert.deepEqual(results, [
    { status: "found", path: `${root}/idp-backend/.env` },
    { status: "found", path: `${root}/p/sub/a.md` },
    { status: "found", path: `${root}/q/a.md` },
  ]);
});
