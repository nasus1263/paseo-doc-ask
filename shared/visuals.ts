import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Visual aids in an explanation. Tables, Mermaid diagrams and web images are Markdown that
 * Paseo draws itself; the plugin draws ```svg and ```html blocks in a sandboxed frame, and turns
 * images on local paths into data URLs, which Paseo's Markdown cannot read from a plugin.
 */

export type Segment = { kind: "markdown"; text: string } | { kind: "svg" | "html"; code: string };

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(svg|html)[ \t]*$/i;

/**
 * Splits `text` into Markdown and the ```svg / ```html blocks between it. A block not closed
 * yet, as in an answer still being written, stays Markdown and shows as code.
 */
export function splitVisuals(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let markdown: string[] = [];
  const flush = () => {
    if (markdown.join("").trim() !== "") segments.push({ kind: "markdown", text: markdown.join("\n") });
    markdown = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_FENCE.exec(lines[i]!);
    if (!open) {
      markdown.push(lines[i]!);
      continue;
    }
    const fence = open[1]!;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end]!)) end++;
    if (end === lines.length) {
      markdown.push(...lines.slice(i));
      break;
    }
    flush();
    segments.push({ kind: open[2]!.toLowerCase() as "svg" | "html", code: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  flush();
  return segments;
}

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g;
const REMOTE = /^(https?:|data:|blob:)/i;

/** The sources of images on local paths in `text`, as written, without duplicates. */
export function localImagePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(IMAGE)) {
    const source = unwrap(match[2]!);
    if (!REMOTE.test(source)) paths.add(source);
  }
  return [...paths];
}

/** `text` with local image sources replaced by `urls` (by source as written); others are kept. */
export function inlineImages(text: string, urls: ReadonlyMap<string, string>): string {
  return text.replace(IMAGE, (whole, alt: string, source: string, title: string | undefined) => {
    const url = urls.get(unwrap(source));
    return url ? `![${alt}](${url}${title ?? ""})` : whole;
  });
}

function unwrap(source: string): string {
  return source.startsWith("<") && source.endsWith(">") ? source.slice(1, -1) : source;
}

/** Reads a local image as a data URL: absolute, or relative to the first base that has it. */
export const imageReadRpc = defineRpc({
  name: "doc-ask.image.read",
  input: z.object({ path: z.string(), bases: z.array(z.string()) }),
  output: z.object({ url: z.string().nullable() }),
});
