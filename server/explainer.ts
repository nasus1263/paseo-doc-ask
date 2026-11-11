import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { explainRpc } from "../shared/explain";

type Paseo = PluginHandlerContext["paseo"];

const LABEL = "paseo-doc-ask";
const PROVIDER = "claude/claude-sonnet-5-5";
const THINKING = "low";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Documents above this size are not inlined; the agent reads them from disk instead. */
const MAX_INLINE_CHARS = 120_000;

const SYSTEM_PROMPT = [
  "너는 문서 해설자다. 사용자가 문서를 읽다가 이해하기 어려운 부분을 선택해 물어보면 쉽게 설명한다.",
  "규칙:",
  "- 파일을 수정하거나 명령을 실행하지 않는다. 문서는 메시지로 전달된다.",
  "- 제목, 인사, 서두 없이 설명 본문만 Markdown으로 출력한다.",
  "- 2~6문장으로 짧게 쓴다. 필요하면 짧은 예시나 비유를 든다.",
  "- 문서와 같은 언어로 답한다.",
].join("\n");

/** Per-workspace agent IDs, and the document text each agent has already seen, by path. */
const agentIds = new Map<string, string>();
const seenDocs = new Map<string, Map<string, string>>();
/** Serializes questions per workspace so the resident agent never gets two turns at once. */
const queues = new Map<string, Promise<unknown>>();

export function explain(input: RpcInput<typeof explainRpc>, { paseo }: PluginHandlerContext) {
  const previous = queues.get(input.workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => ask(paseo, input));
  queues.set(input.workspaceId, next);
  return next;
}

async function ask(paseo: Paseo, input: RpcInput<typeof explainRpc>): Promise<{ answer: string }> {
  const agentId = await residentAgent(paseo, input.workspaceId);
  let result;
  try {
    result = await paseo.agents
      .ref(agentId)
      .run(buildPrompt(agentId, input), { timeoutMs: RUN_TIMEOUT_MS });
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
  return { answer };
}

async function residentAgent(paseo: Paseo, workspaceId: string): Promise<string> {
  const cached = agentIds.get(workspaceId);
  if (cached) return cached;
  const { entries } = await paseo.agents.list({
    includeBackground: true,
    filter: { labels: { [LABEL]: workspaceId }, includeBackground: true },
  });
  const id =
    entries[0]?.agent.id ??
    (
      await paseo.workspaces.ref(workspaceId).agents.create({
        config: { provider: PROVIDER, thinkingOptionId: THINKING, modeId: "default", systemPrompt: SYSTEM_PROMPT },
        title: "문서 해설",
        background: true,
        labels: { [LABEL]: workspaceId },
      })
    ).id;
  agentIds.set(workspaceId, id);
  return id;
}

function buildPrompt(agentId: string, input: RpcInput<typeof explainRpc>): string {
  const known = seenDocs.get(agentId)?.get(input.path) === input.document;
  const parts: string[] = [];
  if (known) {
    parts.push(`문서: ${input.path} (앞서 전달한 내용과 동일)`);
  } else if (input.document.length <= MAX_INLINE_CHARS) {
    parts.push(`문서: ${input.path}`, "<document>", input.document, "</document>");
  } else {
    parts.push(`문서: ${input.path} (길어서 생략됨. 필요하면 Read 도구로 읽어라)`);
  }
  parts.push("", "다음 부분이 이해하기 어렵다. 쉽게 설명해 줘.", "<selection>", input.selection, "</selection>");
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
