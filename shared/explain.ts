import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const askModeSchema = z.enum(["term", "question"]);
export type AskMode = z.infer<typeof askModeSchema>;

/** Asks the workspace's resident explainer agent about a selected passage. */
export const explainRpc = defineRpc({
  name: "doc-ask.explain",
  input: z.object({
    workspaceId: z.string(),
    path: z.string(),
    /** Whole document text at question time. The server sends it only when the agent lacks it. */
    document: z.string(),
    selection: z.string().min(1),
    /** `term` explains the selection; `question` answers `question` about it. */
    mode: askModeSchema,
    question: z.string().optional(),
  }),
  output: z.object({ answer: z.string() }),
});

/** Starts a fresh explainer session for the workspace by archiving the current one. */
export const resetRpc = defineRpc({
  name: "doc-ask.reset",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ retired: z.number() }),
});

/** Extra instructions sent with every question, such as "간단간결히 설명한다". */
export const promptSettings = defineSettings({
  id: "prompt",
  scope: "host",
  version: 1,
  schema: z.object({ extraPrompt: z.string().default("") }),
});
