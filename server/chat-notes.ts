import type { RpcInput } from "@getpaseo/plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { chatNotesReadRpc, chatNotesWriteRpc } from "../shared/chat";

/**
 * Agent footnotes live in a plugin-owned directory under the daemon home, never in Paseo's or
 * the provider's own session records, which their owners rewrite.
 */
function notesDirectory(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-doc-ask", "agents");
}

function notesPath(agentId: string): string {
  if (!/^[\w-]+$/.test(agentId)) throw new Error(`올바르지 않은 에이전트 ID입니다: ${agentId}`);
  return join(notesDirectory(), `${agentId}.comment.md`);
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return "";
    throw cause;
  }
}

export async function readChatNotes({ agentId }: RpcInput<typeof chatNotesReadRpc>) {
  return { text: await readOrEmpty(notesPath(agentId)) };
}

export async function writeChatNotes({ agentId, text, base }: RpcInput<typeof chatNotesWriteRpc>) {
  const path = notesPath(agentId);
  if ((await readOrEmpty(path)) !== base) return { status: "conflict" as const };
  await mkdir(notesDirectory(), { recursive: true });
  await writeFile(path, text, "utf8");
  return { status: "written" as const };
}
