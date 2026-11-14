import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { commitRpc } from "../shared/explain";
import { withExplainer } from "./explainer";
import { commentPathOf } from "../shared/markdown";
import { isAllowedGitCommand } from "./git-policy";
import { READ_TOOLS, runDeciding, type PermissionRequest, type PermissionResponse } from "./permissions";

type Paseo = PluginHandlerContext["paseo"];

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const COMMITTED = "결과: 커밋함";

const DENIED =
  "허용되지 않은 명령이다. 각주 커밋에는 git status/diff/log/show/rev-parse/ls-files, " +
  "git apply --cached, 주석 파일(*.comment.md)만 대상으로 한 git add, 인덱스만 커밋하는 git commit을 " +
  "각각 단독으로(필요하면 git -C <경로>) 실행할 수 있다.";

/** Serializes commits per workspace so two never touch the same git index at once. */
const queues = new Map<string, Promise<unknown>>();

/** Has one of the workspace's explainers commit only the footnote changes of one document. */
export function commitFootnotes(input: RpcInput<typeof commitRpc>, { paseo }: PluginHandlerContext) {
  const previous = queues.get(input.workspaceId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => withExplainer(paseo, input.workspaceId, async (agentId) => ({ value: await commit(paseo, agentId, input), keep: true })));
  queues.set(input.workspaceId, next);
  return next;
}

async function commit(paseo: Paseo, agentId: string, input: RpcInput<typeof commitRpc>) {
  const agent = paseo.agents.ref(agentId);
  const result = await runDeciding(agent, buildPrompt(input.path), RUN_TIMEOUT_MS, decide);
  if (result.status !== "idle") {
    throw new Error(
      result.status === "timeout"
        ? "커밋 요청 응답 시간이 초과되었습니다."
        : `커밋 요청 실패: ${result.error ?? result.status}`,
    );
  }
  const reply = result.lastMessage?.trim() ?? "";
  return { committed: reply.startsWith(COMMITTED), summary: reply || "에이전트가 빈 답을 반환했습니다." };
}

/** Allows reads and the git commands the policy permits; denies everything else. */
function decide(request: PermissionRequest): PermissionResponse {
  if (READ_TOOLS.has(request.name)) return { behavior: "allow" };
  const command = commandOf(request);
  if (command !== null && isAllowedGitCommand(command)) return { behavior: "allow" };
  console.log(`Denied ${request.name}: ${command ?? "(no command)"}`);
  return { behavior: "deny", message: DENIED };
}

function commandOf(request: PermissionRequest): string | null {
  if (request.detail?.type === "shell") return request.detail.command;
  const command = (request.input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" ? command : null;
}

function buildPrompt(path: string): string {
  const comments = commentPathOf(path) ?? "(없음)";
  return [
    "[각주 커밋 요청] 이번 요청에 한해 아래 절차의 git 명령 실행을 허용한다. 문서 해설 규칙의 '명령을 실행하지 않는다'보다 이 요청이 우선한다.",
    `대상 문서: ${path}`,
    `주석 파일: ${comments}`,
    "",
    "할 일: '문서 질문' 플러그인이 단 각주 관련 변경만 git에 커밋한다.",
    "각주 관련 변경은 다음과 같다.",
    "1. 대상 문서 본문에 추가된 `==…==` 하이라이트 표시",
    "2. 대상 문서 본문에 추가된 `[^n]` 각주 참조",
    "3. 주석 파일 전체 (각주 정의 `[^n]: …`를 담는 플러그인 전용 파일)",
    "",
    "절차:",
    "1. 문서가 속한 저장소에서 `git -C <디렉터리> status`와 `git -C <디렉터리> diff --cached`로 확인한다. 이미 스테이징된 변경이 있거나 git 저장소가 아니면 아무것도 바꾸지 말고 중단한다.",
    "2. `git diff -- <대상 문서>`로 변경을 확인하고, 1·2번 변경만 담은 패치를 만들어 `git apply --cached - <<'PATCH'` heredoc으로 스테이징한다. 한 줄에 다른 변경이 섞여 있으면 HEAD의 그 줄에 각주 관련 변경만 반영한 줄로 패치를 만든다.",
    "3. 주석 파일이 있고 변경되었거나 새 파일이면 `git -C <디렉터리> add <주석 파일>`로 통째로 스테이징한다.",
    "4. 스테이징할 각주 관련 변경이 없으면 중단한다. 있으면 `git diff --cached`로 확인한 뒤 `git commit -m \"<메시지>\"`로 커밋한다. 메시지는 한국어로 '<문서 파일 이름>에 각주 추가'와 각주 주제를 짧게 요약한다.",
    "",
    "제약: 작업 트리 파일을 수정하지 않는다. 주석 파일 외의 git add, reset, checkout, restore, stash, push 등 위에 없는 명령과 명령 연결(&&, ;, |)은 쓰지 않는다. 쓰면 거부된다.",
    "",
    `답 형식: 첫 줄은 정확히 \`${COMMITTED}\` 또는 \`결과: 커밋 안 함\`. 이어서 커밋 해시와 포함한 각주, 또는 커밋하지 않은 이유를 짧게 쓴다.`,
  ].join("\n");
}
