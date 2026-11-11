import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { explainRpc, resetRpc } from "../shared/explain";

type Paseo = PluginHandlerContext["paseo"];

const LABEL = "paseo-doc-ask";
const PROVIDER = "claude/claude-sonnet-5-5";
const THINKING = "low";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Documents above this size are not inlined; the agent reads them from disk instead. */
const MAX_INLINE_CHARS = 120_000;
/** Context size at which the resident agent is retired, well before the provider compacts it. */
const ROTATE_AT_TOKENS = 150_000;

const SYSTEM_PROMPT = [
  "너는 문서 해설자다. 사용자는 문서를 읽다가 선택한 부분을 설명해 달라고 하거나, 그 부분에 대해 질문한다.",
  "규칙:",
  "- 파일을 수정하거나 명령을 실행하지 않는다. 문서는 메시지로 전달된다.",
  "- 제목, 인사, 서두 없이 답 본문만 Markdown으로 출력한다.",
  "- 기본은 2~6문장으로 짧게 쓴다. 필요하면 짧은 예시나 비유를 든다.",
  "- 문서와 같은 언어로 답한다.",
  "- 메시지에 <instructions>가 있으면 위 기본 규칙보다 그것을 우선한다.",
].join("\n");

/** Per-workspace agent IDs, and the document text each agent has already seen, by path. */
const agentIds = new Map<string, string>();
const seenDocs = new Map<string, Map<string, string>>();
/** Serializes questions per workspace so the resident agent never gets two turns at once. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  queues.set(workspaceId, next);
  return next;
}

/** The explain handler; `readExtraPrompt` supplies the user's extra instructions per question. */
export function createExplain(readExtraPrompt: () => Promise<string>) {
  return (input: RpcInput<typeof explainRpc>, { paseo }: PluginHandlerContext) =>
    enqueue(input.workspaceId, async () => ask(paseo, input, await readExtraPrompt()));
}

/** Retires the workspace's explainer after any running question; the next question starts fresh. */
export function resetContext(input: RpcInput<typeof resetRpc>, { paseo }: PluginHandlerContext) {
  return enqueue(input.workspaceId, async () => ({ retired: await retire(paseo, input.workspaceId) }));
}

async function ask(
  paseo: Paseo,
  input: RpcInput<typeof explainRpc>,
  extraPrompt: string,
): Promise<{ answer: string }> {
  const agentId = await residentAgent(paseo, input.workspaceId);
  const agent = paseo.agents.ref(agentId);
  let result;
  try {
    result = await agent.run(buildPrompt(agentId, input, extraPrompt), { timeoutMs: RUN_TIMEOUT_MS });
  } catch (cause) {
    // The agent may have been archived or deleted; find or create it again next time.
    agentIds.delete(input.workspaceId);
    seenDocs.delete(agentId);
    throw cause;
  }
  if (result.status !== "idle") {
    // The agent may hold a half-finished turn; forget what it has seen so the next question resends.
    seenDocs.delete(agentId);
    throw new Error(describeFailure(result.status, result.error));
  }
  const answer = result.lastMessage?.trim();
  if (!answer) throw new Error("해설 에이전트가 빈 답을 반환했습니다.");
  rememberDoc(agentId, input);
  const usage = agent.lastUsage;
  const used = usage?.contextWindowUsedTokens ?? (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0);
  if (used >= ROTATE_AT_TOKENS) {
    console.log(`Explainer ${agentId} reached ${used} context tokens; retiring it.`);
    await retire(paseo, input.workspaceId);
  }
  return { answer };
}

/**
 * Archives every explainer of the workspace, with the hidden workspace each one lives in, and
 * forgets their state. Returns how many agents it archived.
 */
async function retire(paseo: Paseo, workspaceId: string): Promise<number> {
  const hidden = new Map<string, string | null>();
  const cached = agentIds.get(workspaceId);
  if (cached) hidden.set(cached, null);
  for (const { agent } of await labelledAgents(paseo, workspaceId)) {
    hidden.set(agent.id, agent.workspaceId ?? null);
  }
  agentIds.delete(workspaceId);
  let archived = 0;
  for (const [id, home] of hidden) {
    seenDocs.delete(id);
    try {
      await paseo.agents.ref(id).archive();
      archived++;
      // Never archive the user's workspace, only the explainer's own hidden one.
      if (home && home !== workspaceId) await paseo.workspaces.archive(home);
    } catch (cause) {
      console.error(`Could not archive explainer ${id}:`, cause);
    }
  }
  return archived;
}

function labelledAgents(paseo: Paseo, workspaceId: string) {
  return paseo.agents
    .list({ includeBackground: true, filter: { labels: { [LABEL]: workspaceId }, includeBackground: true } })
    .then(({ entries }) => entries);
}

/**
 * The workspace's explainer, found by label or created. This daemon rejects background agents in
 * an existing workspace, so the explainer gets its own hidden workspace on the same directory.
 */
async function residentAgent(paseo: Paseo, workspaceId: string): Promise<string> {
  const cached = agentIds.get(workspaceId);
  if (cached) return cached;
  const [existing] = await labelledAgents(paseo, workspaceId);
  let id = existing?.agent.id;
  if (!id) {
    const workspace = paseo.workspaces.ref(workspaceId);
    await workspace.refresh();
    if (!workspace.directory) throw new Error("워크스페이스 디렉터리를 찾지 못했습니다.");
    const agent = await paseo.agents.create({
      cwd: workspace.directory,
      config: { provider: PROVIDER, thinkingOptionId: THINKING, modeId: "default", systemPrompt: SYSTEM_PROMPT },
      title: "문서 해설",
      background: true,
      labels: { [LABEL]: workspaceId },
    });
    id = agent.id;
  }
  agentIds.set(workspaceId, id);
  return id;
}

function buildPrompt(agentId: string, input: RpcInput<typeof explainRpc>, extraPrompt: string): string {
  const known = seenDocs.get(agentId)?.get(input.path) === input.document;
  const parts: string[] = [];
  if (known) {
    parts.push(`문서: ${input.path} (앞서 전달한 내용과 동일)`);
  } else if (input.document.length <= MAX_INLINE_CHARS) {
    parts.push(`문서: ${input.path}`, "<document>", input.document, "</document>");
  } else {
    parts.push(`문서: ${input.path} (길어서 생략됨. 필요하면 Read 도구로 읽어라)`);
  }
  parts.push("", "<selection>", input.selection, "</selection>");
  const question = input.question?.trim();
  if (input.mode === "question" && question) {
    parts.push("위 선택 부분에 대한 질문에 답해 줘.", "<question>", question, "</question>");
  } else {
    parts.push("위 선택 부분이 이해하기 어렵다. 쉽게 설명해 줘.");
  }
  const extra = extraPrompt.trim();
  if (extra) parts.push("<instructions>", extra, "</instructions>");
  return parts.join("\n");
}

function rememberDoc(agentId: string, input: RpcInput<typeof explainRpc>) {
  if (input.document.length > MAX_INLINE_CHARS) return;
  let docs = seenDocs.get(agentId);
  if (!docs) seenDocs.set(agentId, (docs = new Map()));
  docs.set(input.path, input.document);
}

function describeFailure(status: string, error: string | null): string {
  if (status === "permission") return "해설 에이전트가 권한 승인을 기다리고 있습니다. Paseo에서 확인해 주세요.";
  if (status === "timeout") return "해설 에이전트 응답 시간이 초과되었습니다.";
  return `해설 에이전트 오류: ${error ?? status}`;
}
