import type { RpcInput } from "@getpaseo/plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type TempNote, tempNotesFileName, type tempNotesReadRpc, type tempNotesWriteRpc } from "../shared/temp-notes";

/** 임시 각주 live in the plugin's own data directory, one JSON file per document or agent. */
function notesPath(file: string): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-doc-ask", "temp-notes", tempNotesFileName(file));
}

export async function readTempNotes({ file }: RpcInput<typeof tempNotesReadRpc>): Promise<{ notes: TempNote[] }> {
  try {
    const stored = JSON.parse(await readFile(notesPath(file), "utf8")) as { file?: string; notes?: TempNote[] };
    return { notes: stored.file === file && Array.isArray(stored.notes) ? stored.notes : [] };
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return { notes: [] };
    throw cause;
  }
}

export async function writeTempNotes({ file, notes }: RpcInput<typeof tempNotesWriteRpc>) {
  const path = notesPath(file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ file, notes }, null, 2), "utf8");
  return {};
}
