import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { explainRpc, resetRpc } from "../shared/explain";
import { READ_TOOLS, runDeciding, type PermissionRequest, type PermissionResponse } from "./permissions";
import { AgentPool } from "./pool";
import { AnswerDraft, endAnswer, publishAnswer } from "./stream";

type Paseo = PluginHandlerContext["paseo"];

const LABEL = "paseo-doc-ask";
const PROVIDER = "claude/claude-sonnet-5-5";
const THINKING = "low";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Documents above this size are not inlined; the agent reads them from disk instead. */
const MAX_INLINE_CHARS = 120_000;
/** Context size at which the resident agent is retired, well before the provider compacts it. */
const ROTATE_AT_TOKENS = 150_000;
/** Explainers per workspace, so at most this many questions run at once; the rest wait. */
const MAX_AGENTS = 4;

const SYSTEM_PROMPT = [
  "너는 문서 해설자다. 사용자는 문서를 읽다가 선택한 부분을 설명해 달라고 하거나, 그 부분에 대해 질문한다.",
  "규칙:",
  "- 파일을 수정하거나 명령을 실행하지 않는다. 문서는 메시지로 전달된다.",
  "- 제목, 인사, 서두 없이 답 본문만 Markdown으로 출력한다.",
  "- 기본은 2~6문장으로 짧게 쓴다. 필요하면 짧은 예시나 비유를 든다.",
  "- 문서와 같은 언어로 답한다.",
  "- 범위를 쓸 때 물결표(~)를 쓰지 않는다. Markdown에서 취소선이 된다. '65–75점'이나 '65점에서 75점'처럼 쓴다.",
  "- 모양, 구조, 배치, 흐름, 관계, 수치 비교처럼 눈으로 보면 이해가 빠른 것을 설명할 때는 이해를 돕는 자료를 하나 함께 넣는다. 짧은 정의나 단순한 개념에는 넣지 않는다. 형식은 내용에 맞게 고른다:",
  "  - 여러 항목의 속성 비교·정리: Markdown 표",
  "  - 절차, 흐름, 구조, 관계, 상태 변화, 시간 순서: ```mermaid 코드 블록 (flowchart, sequenceDiagram, stateDiagram, classDiagram, erDiagram, timeline, pie 등)",
  "  - 도형, 배치, 원리를 보여주는 정적인 그림이나 그래프: ```svg 코드 블록. 완결된 <svg> 하나, viewBox를 지정하고 width/height 속성은 생략한다.",
  "  - 움직임, 상호작용, 3D, 함수 그래프 등 동적인 시각화: ```html 코드 블록. 그대로 실행되는 HTML(필요하면 <script>, <canvas>). 외부 라이브러리는 https://cdn.jsdelivr.net 같은 CDN에서 불러오고, 3D는 three.js를 쓴다. 높이는 400px 이하의 고정 px로 정하고 vh는 쓰지 않는다.",
  "  - 실제 사진이나 스크린샷이 필요하면 ![설명](경로)로 워크스페이스에 있는 이미지 파일(절대 경로나 문서 기준 상대 경로)을 넣는다. 웹 이미지 URL은 존재가 확실할 때만 쓰고, 지어낸 URL은 쓰지 않는다.",
  "  - svg와 html의 색은 CSS 변수 var(--fg), var(--muted), var(--accent), var(--border), var(--surface), var(--bg)를 써서 라이트·다크 테마에 맞춘다.",
  "- 메시지에 <instructions>가 있으면 위 기본 규칙보다 그것을 우선한다.",
].join("\n");

/** The document text each agent has already seen, by agent ID and path. */
const seenDocs = new Map<string, Map<string, string>>();
/** Per-workspace explainer pools: questions asked together each get their own agent. */
const pools = new Map<string, AgentPool>();

/** The explain handler; `readExtraPrompt` supplies the user's extra instructions per question. */
export function createExplain(readExtraPrompt: () => Promise<string>) {
  return async (input: RpcInput<typeof explainRpc>, { paseo }: PluginHandlerContext) =>
    withExplainer(paseo, input.workspaceId, async (agentId) => ask(paseo, agentId, input, await readExtraPrompt()));
}

/** Retires the workspace's explainers, running ones once they finish; the next question starts fresh. */
export async function resetContext(input: RpcInput<typeof resetRpc>, { paseo }: PluginHandlerContext) {
  return { retired: await poolFor(paseo, input.workspaceId).retireAll() };
}

/**
 * Lends one of the workspace's explainers to `work`. The agent goes back to the pool when `work`
 * returns `keep: true`, and is archived when it returns `keep: false` or throws.
 */
export async function withExplainer<T>(
  paseo: Paseo,
  workspaceId: string,
  work: (agentId: string) => Promise<{ value: T; keep: boolean }>,
): Promise<T> {
  const pool = poolFor(paseo, workspaceId);
  const agentId = await pool.acquire();
  let keep = false;
  try {
    const result = await work(agentId);
    keep = result.keep;
    return result.value;
  } finally {
    void pool.release(agentId, keep);
  }
}

async function ask(
  paseo: Paseo,
  agentId: string,
  input: RpcInput<typeof explainRpc>,
  extraPrompt: string,
): Promise<{ value: { answer: string }; keep: boolean }> {
  const agent = paseo.agents.ref(agentId);
  const stopStreaming = input.requestId ? await streamAnswer(agent, input.requestId) : undefined;
  let result;
  try {
    // A throw, such as for an archived or deleted agent, discards the agent.
    result = await runDeciding(agent, buildPrompt(agentId, input, extraPrompt), RUN_TIMEOUT_MS, readOnly);
  } finally {
    stopStreaming?.();
  }
  // The agent may hold a half-finished turn; the pool discards it.
  if (result.status !== "idle") throw new Error(describeFailure(result.status, result.error));
  const answer = result.lastMessage?.trim();
  if (!answer) throw new Error("해설 에이전트가 빈 답을 반환했습니다.");
  rememberDoc(agentId, input);
  const usage = agent.lastUsage;
  const used = usage?.contextWindowUsedTokens ?? (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0);
  if (used >= ROTATE_AT_TOKENS) console.log(`Explainer ${agentId} reached ${used} context tokens; retiring it.`);
  return { value: { answer }, keep: used < ROTATE_AT_TOKENS };
}

/**
 * Publishes the answer `agent` writes under `requestId` until the returned function is called.
 * Without a live timeline the question still runs, only without a draft.
 */
async function streamAnswer(agent: ReturnType<Paseo["agents"]["ref"]>, requestId: string): Promise<() => void> {
  const draft = new AnswerDraft();
  const subscription = agent.timeline.subscribe((message) => {
    const event = message.event;
    if (event.type === "timeline" && draft.add(event.item)) publishAnswer(requestId, draft.text);
  });
  try {
    await subscription.ready;
  } catch (cause) {
    console.error("Could not follow the explainer's answer:", cause);
  }
  return () => {
    subscription();
    endAnswer(requestId);
  };
}

function poolFor(paseo: Paseo, workspaceId: string): AgentPool {
  let pool = pools.get(workspaceId);
  if (!pool) {
    pool = new AgentPool(
      MAX_AGENTS,
      () => createExplainer(paseo, workspaceId),
      (id) => archiveExplainer(paseo, workspaceId, id),
      labelledAgents(paseo, workspaceId).then((entries) => entries.map(({ agent }) => agent.id)),
    );
    pools.set(workspaceId, pool);
  }
  return pool;
}

/** Archives an explainer with the hidden workspace it lives in, and forgets its state. */
async function archiveExplainer(paseo: Paseo, workspaceId: string, id: string): Promise<void> {
  seenDocs.delete(id);
  try {
    const agent = paseo.agents.ref(id);
    await agent.refresh();
    const home = agent.workspaceId;
    await agent.archive();
    // Never archive the user's workspace, only the explainer's own hidden one.
    if (home && home !== workspaceId) await paseo.workspaces.archive(home);
  } catch (cause) {
    console.error(`Could not archive explainer ${id}:`, cause);
  }
}

function labelledAgents(paseo: Paseo, workspaceId: string) {
  return paseo.agents
    .list({ includeBackground: true, filter: { labels: { [LABEL]: workspaceId }, includeBackground: true } })
    .then(({ entries }) => entries);
}

/**
 * Creates an explainer for the workspace. This daemon rejects background agents in an existing
 * workspace, so the explainer gets its own hidden workspace on the same directory.
 */
async function createExplainer(paseo: Paseo, workspaceId: string): Promise<string> {
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
  return agent.id;
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
  const context = input.context?.trim();
  if (context) {
    parts.push(
      "",
      "아래는 이 문서의 한 부분에 대해 앞서 작성된 설명(각주)이다. 선택 부분은 이 설명에서 가져왔다.",
      "<note>",
      context,
      "</note>",
    );
  }
  parts.push("", "<selection>", input.selection, "</selection>");
  const question = input.question?.trim();
  if (input.mode === "question" && question) {
    parts.push("위 선택 부분에 대한 질문에 답해 줘.", "<question>", question, "</question>");
  } else if (question) {
    // 설명 with text typed in the selection box: explain the way the reader asked.
    parts.push("위 선택 부분을 다음 요청에 맞게 설명해 줘.", "<request>", question, "</request>");
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

/** Explaining only reads: file reads are allowed anywhere, every other tool is denied. */
export function readOnly(request: PermissionRequest): PermissionResponse {
  if (READ_TOOLS.has(request.name)) return { behavior: "allow" };
  console.log(`Denied ${request.name} while explaining`);
  return { behavior: "deny", message: "문서 해설 중에는 파일 읽기(Read, Grep, Glob, LS)만 허용된다. 명령 실행이나 수정 없이 답하라." };
}

function describeFailure(status: string, error: string | null): string {
  if (status === "permission") return "해설 에이전트가 권한 승인에서 멈춰 중단했습니다. 다시 요청해 주세요.";
  if (status === "timeout") return "해설 에이전트 응답 시간이 초과되었습니다.";
  return `해설 에이전트 오류: ${error ?? status}`;
}
