import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Asks the workspace's resident explainer agent about a selected passage. */
export const explainRpc = defineRpc({
  name: "doc-ask.explain",
  input: z.object({
    workspaceId: z.string(),
    path: z.string(),
    /** Whole document text at question time. The server sends it only when the agent lacks it. */
    document: z.string(),
    selection: z.string().min(1),
  }),
  output: z.object({ answer: z.string() }),
});

/** Starts a fresh explainer session for the workspace by archiving the current one. */
export const resetRpc = defineRpc({
  name: "doc-ask.reset",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ retired: z.number() }),
});
