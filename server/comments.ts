import type { RpcInput } from "@getpaseo/plugin";
import { readFile, writeFile } from "node:fs/promises";
import type { commentsReadRpc, commentsWriteRpc } from "../shared/explain";
import { commentPathOf } from "../shared/markdown";

function commentPath(documentPath: string): string {
  const path = commentPathOf(documentPath);
  if (!path) throw new Error(`주석 파일을 둘 수 없는 문서입니다: ${documentPath}`);
  return path;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return "";
    throw cause;
  }
}

export async function readComments({ path }: RpcInput<typeof commentsReadRpc>) {
  return { text: await readOrEmpty(commentPath(path)) };
}

export async function writeComments({ path, text, base }: RpcInput<typeof commentsWriteRpc>) {
  const target = commentPath(path);
  if ((await readOrEmpty(target)) !== base) return { status: "conflict" as const };
  await writeFile(target, text, "utf8");
  return { status: "written" as const };
}
