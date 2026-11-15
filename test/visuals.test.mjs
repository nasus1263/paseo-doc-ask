import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineImages, localImagePaths, splitVisuals } from "../shared/visuals.ts";

test("splitVisuals separates closed svg and html blocks from Markdown", () => {
  const text = "앞 문단\n\n```svg\n<svg viewBox=\"0 0 1 1\"></svg>\n```\n\n| a | b |\n|---|---|\n\n~~~HTML\n<p>x</p>\n~~~\n뒤";
  assert.deepEqual(splitVisuals(text), [
    { kind: "markdown", text: "앞 문단\n" },
    { kind: "svg", code: '<svg viewBox="0 0 1 1"></svg>' },
    { kind: "markdown", text: "\n| a | b |\n|---|---|\n" },
    { kind: "html", code: "<p>x</p>" },
    { kind: "markdown", text: "뒤" },
  ]);
});

test("splitVisuals leaves other fences and unclosed blocks as Markdown", () => {
  const mermaid = "```mermaid\ngraph TD; A-->B\n```";
  assert.deepEqual(splitVisuals(mermaid), [{ kind: "markdown", text: mermaid }]);
  const streaming = "설명\n```html\n<canvas>";
  assert.deepEqual(splitVisuals(streaming), [{ kind: "markdown", text: streaming }]);
  // A shorter fence inside does not close a longer one.
  assert.deepEqual(splitVisuals("````html\n```\n````"), [{ kind: "html", code: "```" }]);
});

test("local images are listed and replaced; web and data images are kept", () => {
  const text = '![a](img/a.png) ![b](https://x/b.png) ![c](<C:/my dir/c.png> "t") ![a again](img/a.png)';
  assert.deepEqual(localImagePaths(text), ["img/a.png", "C:/my dir/c.png"]);
  const urls = new Map([["img/a.png", "data:image/png;base64,AA"]]);
  assert.equal(
    inlineImages(text, urls),
    '![a](data:image/png;base64,AA) ![b](https://x/b.png) ![c](<C:/my dir/c.png> "t") ![a again](data:image/png;base64,AA)',
  );
});
