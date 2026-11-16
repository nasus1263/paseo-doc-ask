import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** A tool an explainer asked to use while answering, waiting for the user's decision. */
export const permissionPromptSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** The tool's name, such as `Bash`. */
  tool: z.string(),
  title: z.string().nullable(),
  /** What the tool would do: its description, else its input. */
  detail: z.string(),
});
export type PermissionPrompt = z.infer<typeof permissionPromptSchema>;

/** Every permission waiting for the user, sent again whenever the list changes. */
export const permissionPromptsStream = defineSubscription({
  name: "doc-ask.permission.prompts",
  input: z.object({}),
  event: z.object({ prompts: z.array(permissionPromptSchema) }),
});

/** Answers one waiting permission. */
export const permissionRespondRpc = defineRpc({
  name: "doc-ask.permission.respond",
  input: z.object({ id: z.string(), allow: z.boolean() }),
  output: z.object({ answered: z.boolean() }),
});
