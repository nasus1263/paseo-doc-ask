import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type Paseo = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
export type PermissionRequest = NonNullable<AgentHandle["pendingPermissions"]>[number];
export type PermissionResponse = Parameters<AgentHandle["respondToPermission"]>[0]["response"];
export type Decide = (request: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
type RunResult = Awaited<ReturnType<AgentHandle["run"]>>;

/** Upper bound on permission round trips, so a looping agent cannot hang the queue. */
const MAX_PERMISSION_ROUNDS = 40;

export const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

/** Runs a turn, answering every permission request it raises with `decide` until it settles. */
export async function runDeciding(
  agent: Pick<AgentHandle, "run" | "refresh" | "pendingPermissions" | "respondToPermission" | "waitForFinish">,
  prompt: string,
  timeoutMs: number,
  decide: Decide,
): Promise<RunResult> {
  let result = await agent.run(prompt, { timeoutMs });
  for (let round = 0; result.status === "permission" && round < MAX_PERMISSION_ROUNDS; round++) {
    await agent.refresh();
    const pending = agent.pendingPermissions ?? [];
    if (pending.length === 0) break;
    for (const request of pending) {
      await agent.respondToPermission({ requestId: request.id, response: await decide(request) });
    }
    result = await agent.waitForFinish(timeoutMs);
  }
  return result;
}
