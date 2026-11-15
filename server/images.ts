import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { imageReadRpc } from "../shared/visuals";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const MAX_BYTES = 8 * 1024 * 1024;

/** Reads an image file named in an explanation; only image types, and only up to 8 MB. */
export async function readImage({ path, bases }: RpcInput<typeof imageReadRpc>) {
  let written = path.replace(/^file:\/\//i, "").replace(/\\/g, "/");
  try {
    written = decodeURI(written);
  } catch {
    // Kept as written: a literal "%" in a file name.
  }
  // file:///C:/a.png leaves "/C:/a.png".
  written = written.replace(/^\/([A-Za-z]:\/)/, "$1");
  const type = TYPES[extname(written).toLowerCase()];
  if (!type) return { url: null };
  const candidates = isAbsolute(written) ? [written] : bases.map((base) => join(base, written));
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile() || info.size > MAX_BYTES) continue;
    const bytes = await readFile(candidate);
    return { url: `data:${type};base64,${bytes.toString("base64")}` };
  }
  return { url: null };
}
