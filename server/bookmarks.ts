import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readdir, readFile, stat } from "node:fs/promises";
import type { bookmarksRpc } from "../shared/explain";
import { listBookmarks } from "../shared/markdown";

/** Directories never searched for comment files: dependencies, build output, VCS data. */
const SKIP = new Set(["node_modules", "dist", "build", "out", "obj", "bin", "Library", "Temp", "venv", "__pycache__"]);
const MAX_DEPTH = 12;
const MAX_FILES = 1000;

/**
 * One page of the bookmarked footnotes of every `*.comment.md` under the workspace directory,
 * ordered by when they were bookmarked. Bookmarks made before that time was recorded take their
 * comment file's last change.
 */
export async function listWorkspaceBookmarks(
  { workspaceId, order, offset, limit }: RpcInput<typeof bookmarksRpc>,
  { paseo }: PluginHandlerContext,
) {
  const workspace = paseo.workspaces.ref(workspaceId);
  await workspace.refresh();
  if (!workspace.directory) throw new Error("워크스페이스 디렉터리를 찾지 못했습니다.");
  const files = await findCommentFiles(workspace.directory.replace(/[\/]+$/, ""));
  const items = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const bookmarks = listBookmarks(text);
    if (bookmarks.length === 0) continue;
    const documentPath = await documentOf(file);
    const changed = new Date((await stat(file)).mtimeMs).toISOString();
    for (const bookmark of bookmarks) items.push({ documentPath, ...bookmark, bookmarkedAt: bookmark.bookmarkedAt ?? changed });
  }
  // ISO times in UTC compare as strings; ties keep document and label order.
  const sign = order === "asc" ? 1 : -1;
  items.sort((a, b) => sign * (a.bookmarkedAt < b.bookmarkedAt ? -1 : a.bookmarkedAt > b.bookmarkedAt ? 1 : 0));
  return { items: items.slice(offset, offset + limit), total: items.length };
}

async function findCommentFiles(dir: string, depth = 0, found: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return found;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !SKIP.has(entry.name)) await findCommentFiles(path, depth + 1, found);
    } else if (entry.isFile() && /\.comment\.md$/i.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** The document a comment file belongs to: `a.comment.md` → `a.md`, or `a.markdown` if that exists. */
async function documentOf(commentFile: string): Promise<string> {
  const base = commentFile.replace(/\.comment\.md$/i, "");
  try {
    await stat(`${base}.md`);
    return `${base}.md`;
  } catch {
    try {
      await stat(`${base}.markdown`);
      return `${base}.markdown`;
    } catch {
      return `${base}.md`;
    }
  }
}
