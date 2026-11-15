import { defineRpc, defineSettings, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** `term` explains, `question` answers a question, `visual` explains through a visual aid. */
export const askModeSchema = z.enum(["term", "question", "visual"]);
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
    /** An earlier explanation the selection was taken from, when asking about a footnote. */
    context: z.string().optional(),
    /** The passage of the document or answer that footnote is about, when asking about one. */
    passage: z.string().optional(),
    /** Names the request so `explainStream` can follow its answer while it is written. */
    requestId: z.string().optional(),
  }),
  output: z.object({ answer: z.string() }),
});

/** The answer of an `explainRpc` request so far, sent again as it grows. */
export const explainStream = defineSubscription({
  name: "doc-ask.explain.stream",
  input: z.object({ requestId: z.string() }),
  event: z.object({ text: z.string() }),
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

/** Asks the workspace's explainer to commit only the footnote changes of a document. */
export const commitRpc = defineRpc({
  name: "doc-ask.commit-footnotes",
  input: z.object({ workspaceId: z.string(), path: z.string() }),
  output: z.object({ committed: z.boolean(), summary: z.string() }),
});

/** Reads a document's comment file (`a.md` → `a.comment.md`); empty when it does not exist. */
export const commentsReadRpc = defineRpc({
  name: "doc-ask.comments.read",
  input: z.object({ path: z.string() }),
  output: z.object({ text: z.string() }),
});

/** Writes a document's comment file if it still holds `base`, so concurrent edits are not lost. */
export const commentsWriteRpc = defineRpc({
  name: "doc-ask.comments.write",
  input: z.object({ path: z.string(), text: z.string(), base: z.string() }),
  output: z.object({ status: z.enum(["written", "conflict"]) }),
});

/**
 * One page of the bookmarked footnotes across the workspace's comment files, ordered by when
 * they were bookmarked (the comment file's last change for bookmarks older than that record).
 */
export const bookmarksRpc = defineRpc({
  name: "doc-ask.bookmarks",
  input: z.object({
    workspaceId: z.string(),
    order: z.enum(["asc", "desc"]).default("desc"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(20),
  }),
  output: z.object({
    items: z.array(
      z.object({
        documentPath: z.string(),
        label: z.string(),
        title: z.string(),
        memo: z.string().nullable(),
        content: z.string(),
        /** ISO time the list is ordered by. */
        bookmarkedAt: z.string(),
      }),
    ),
    total: z.number(),
  }),
});
