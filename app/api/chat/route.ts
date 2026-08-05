import { randomUUID } from "node:crypto";
import { isValidModelId } from "@/lib/ai/models";
import { AGENT_SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { getChatModel, markCurrentEndpointFailed } from "@/lib/ai/provider";
import { type SkillContext, type SkillLoadEvidenceEntry, buildTools } from "@/lib/ai/tools";
import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { normalizeAttachmentParts } from "@/lib/chat/attachments";
import { aiConfig } from "@/lib/config";
import { contextConfig } from "@/lib/config";
import {
  estimateMessagesTokens,
  estimateTokens,
  resolveTokenBudget,
  shouldCompress,
} from "@/lib/context/budget";
import { recordContextSnapshot } from "@/lib/context/manifest";
import { assembleModelMessages, buildContextPackage } from "@/lib/context/package-builder";
import { getPinnedFacts } from "@/lib/context/pinned-facts";
import { latestUserText } from "@/lib/context/protected-refs";
import { parseContextCommands } from "@/lib/context/user-commands";
import {
  type CustomToolDeclaration,
  listEnabledCustomTools,
  parseDeclaration,
} from "@/lib/custom-tools/registry";
import {
  appendThreadEvent,
  createThreadRun,
  deleteMessagesFromId,
  failThreadRun,
  getActiveThreadPlan,
  getActiveThreadRun,
  getLatestResolvedApprovalByThread,
  getLatestThreadRun,
  getMessagesByThreadId,
  getPendingApprovalsByThread,
  getSkillById,
  getSkillVersion,
  getThreadByIdForUser,
  getThreadByIdIncludingDeleted,
  listContextSnapshotsForThread,
  listSubagentRunsByThread,
  listThreadEvents,
  listThreadRunSkillsByRun,
  listToolRunsByThread,
  saveMessages,
  saveThread,
  saveThreadRunSkills,
  updateGeneratedTitle,
  updateThreadModel,
  updateThreadPreviewUrl,
  updateThreadStatus,
} from "@/lib/db/queries";
import type { MemoryScope, User } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { resolveEmbeddingProvider } from "@/lib/memory/embedding";
import { retrieveMemories } from "@/lib/memory/retrieve";
import { resolveRuntimeTypeForThread } from "@/lib/runtime/resolver";
import { enqueue, getActiveRunForThread, startReaper } from "@/lib/runtime/thread-runner";
import { type SkillSummary, getSkillProvider } from "@/lib/skill/provider";
import {
  type SelectedSkillVersion,
  type SkillResolverOutput,
  type SkillRole,
  resolveSkillForRun,
} from "@/lib/skill/resolver";
import type { SkillRuntimeContext } from "@/lib/skill/runtime-context";
import { buildSubagentSummary, renderSubagentSummaries } from "@/lib/subagent/summary";
import { chooseThreadTitle, fallbackTitleFromUserText } from "@/lib/thread-title";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID, getTextFromMessage } from "@/lib/utils";
import { isValidThreadId, readWorkspaceFile } from "@/lib/workspace";
import { generateText } from "ai";

export const maxDuration = 300; // B-4：原 60 砍断长任务；runner reaper 5min 兜底，POST 仅提交任务可快速返回

/**
 * C-1: 首条消息时并行生成会话标题（与对话 run 并行，不阻塞）。
 * 仅以首条消息文本为输入，同对话 modelId，生成 6-12 字中文标题 → updateGeneratedTitle。
 * 首条唯一触发，无需 onlyIfTruncated / titleUpdatedAt 防抖守门。fail-open：失败仅 warn。
 */
async function generateThreadTitle(threadId: string, firstMessageText: string, modelId: string) {
  const dialog = firstMessageText.slice(0, 500).trim();

  console.log("[generateThreadTitle] 开始生成标题", {
    threadId,
    dialogLength: dialog.length,
    dialogPreview: dialog.slice(0, 100),
  });

  if (!dialog) {
    console.warn("[generateThreadTitle] 跳过：无文本内容（可能是纯附件消息）");
    return; // 纯附件无文本 → 不生成（保留"新会话"占位，用户可手动重生成）
  }

  const fallbackTitle = fallbackTitleFromUserText(dialog);
  console.log("[generateThreadTitle] 兜底标题已准备", { fallbackTitle });

  try {
    console.log("[generateThreadTitle] 调用LLM生成...", { modelId });

    const { text } = await generateText({
      model: getChatModel(modelId),
      system:
        "你是标题生成器。根据用户的首条消息，生成一个 6-12 字的简洁中文标题，" +
        "概括用户意图。只输出标题文本，不要引号、不要标点、不要多余解释。",
      prompt: dialog,
      maxOutputTokens: 50,
    });

    console.log("[generateThreadTitle] LLM返回", {
      rawText: text,
      textPreview: text?.slice(0, 100),
    });

    const title = chooseThreadTitle(text, fallbackTitle);

    console.log("[generateThreadTitle] 最终标题确定", {
      title,
      source: title === fallbackTitle ? "fallback" : "llm",
    });

    if (title) {
      await updateGeneratedTitle(threadId, title);
      await appendThreadEvent(threadId, "thread.title_updated", { title, source: "llm" });
      console.log("[generateThreadTitle] ✅ 标题已更新到数据库", { threadId, title });
    }
  } catch (error) {
    console.error("[generateThreadTitle] ❌ LLM调用失败", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (fallbackTitle) {
      console.log("[generateThreadTitle] 使用兜底标题", { fallbackTitle });
      await updateGeneratedTitle(threadId, fallbackTitle);
      await appendThreadEvent(threadId, "thread.title_updated", {
        title: fallbackTitle,
        source: "fallback",
        reason: "llm_failed",
      });
      console.log("[generateThreadTitle] 兜底标题已更新到数据库", { threadId, fallbackTitle });
    }
    logger.warn("[chat] 首条消息标题生成失败，已使用兜底标题", {
      threadId,
      error: String(error),
    });
  }
}

function normalizeCustomToolDeclarations(
  rows: Awaited<ReturnType<typeof listEnabledCustomTools>>,
): CustomToolDeclaration[] {
  const declarations: CustomToolDeclaration[] = [];
  for (const row of rows) {
    const parsed = parseDeclaration(row);
    if (parsed.ok) {
      declarations.push(parsed.declaration);
    } else {
      logger.warn("忽略非法自定义工具声明", { name: row.name, error: parsed.error });
    }
  }
  return declarations;
}

/**
 * 组装 skill 版本的 system prompt（Phase 3 §6.3）。
 *
 * - promptTemplate：真实生效（替换硬编码 AGENT_SYSTEM_PROMPT）
 * - completionCriteria：作为软约束提示注入 prompt 尾部（不做硬门禁）
 * - reviewMode / artifactPolicy：仅存储，此处不消费（行为留 Phase 4）
 *
 * 导出供单测；route 内 POST 调用。
 */
/**
 * 组装 skill 的 system prompt（Phase 3 §6.3 + 目录形态加载）。
 *
 * - commitSha 存在（目录形态）：注入 skill 描述 + 指引 agent 用 readSkillFile 读 SKILL.md，
 *   完整指令由 skill 目录承载（不再塞 promptTemplate）。
 * - commitSha 缺失但 promptTemplate 存在（迁移期旧版本）：回退旧逻辑，原样塞 promptTemplate。
 * - 两者皆无：回退硬编码 AGENT_SYSTEM_PROMPT。
 * - completionCriteria：作为软约束提示注入 prompt 尾部（不做硬门禁）。
 *
 * 导出供单测；route 内 POST 调用。
 */
export function composeSkillSystemPrompt(args: {
  skill: { name: string; description?: string | null };
  version: {
    commitSha?: string | null;
    promptTemplate?: string | null;
    completionCriteria?: unknown;
    /**
     * V8 补充方案阶段 3：true 时注入 readSkillFile 指引（本地有 commitSha 或企业平台 Skill）。
     * 缺省时回退到 Boolean(commitSha)，保持向后兼容。
     */
    hasSkillFile?: boolean;
  };
}): string {
  const { skill, version } = args;
  let system: string;
  const hasSkillFile = version.hasSkillFile ?? Boolean(version.commitSha);
  if (hasSkillFile) {
    system = [
      `你是 SnowHarness 平台的 AI 开发助手，当前使用 skill「${skill.name}」。`,
      skill.description ?? "",
      "",
      "## Skill 加载",
      `你的完整工作指令在该 skill 目录的 SKILL.md 中。**首先调用 readSkillFile(path: "SKILL.md") 读取完整指令**，按其指引工作。`,
      "需要参考资料时再用 readSkillFile 读取目录内其他文件（如 references/xxx.md）。",
    ].join("\n");
  } else if (version.promptTemplate) {
    system = version.promptTemplate;
  } else {
    system = AGENT_SYSTEM_PROMPT;
  }
  if (version.completionCriteria) {
    // 形状开放（JSON），软约束阶段直接以可读文本注入尾部
    system += `\n\n## 完成判定（软约束）\n${JSON.stringify(version.completionCriteria)}`;
  }
  return system;
}

/**
 * Thread 可见性守卫（Phase 4-3）。
 *
 * 请求带了 thread id 但当前用户不持有该 thread → 404（用 404 而非 403，不泄露
 * 其他用户 thread 是否存在）。返回 null 表示放行。导出供单测；POST 内调用。
 */
export function assertThreadVisible(
  bodyHadThreadId: boolean,
  existingThread: unknown,
  anyThread?: unknown,
): Response | null {
  if (bodyHadThreadId && !existingThread && anyThread) {
    return new Response("Thread Not Found", { status: 404 });
  }
  return null;
}

/**
 * V3.1：审批恢复决策（纯函数，供 route 测试，不触 DB）。
 *
 * thread 处于 `awaiting_approval` 时，最近一条已决议（approved/denied）的审批请求决定恢复语义：
 * - approved → 恢复执行（前端重发 chat，模型重试工具，引擎查到批准 → allow）
 * - denied   → 回 idle（注入拒绝 system message，不重试同工具）
 * - 其余（非 awaiting_approval / 无已决议审批）→ 不可恢复
 */
export function decideApprovalResume(args: {
  threadStatus: string | null | undefined;
  latestResolved: { status: string; id: string } | null;
}): { resume: false } | { resume: true; kind: "approved" | "denied"; approvalId: string } {
  if (args.threadStatus !== "awaiting_approval") return { resume: false };
  const r = args.latestResolved;
  if (!r) return { resume: false };
  if (r.status === "approved") return { resume: true, kind: "approved", approvalId: r.id };
  if (r.status === "denied") return { resume: true, kind: "denied", approvalId: r.id };
  return { resume: false };
}

/**
 * S1（11-P1-3）：skill 自动匹配(含 LLM 兜底)。
 *
 * V8：已移除。Skill 解析改为 Run 级 Resolver（lib/skill/resolver.ts），
 * chat route 不再直接调用 matchSkill/matchSkillWithLlm。
 * Resolver 内部复用 pickBestSkill 做关键词匹配，LLM 兜底留待后续阶段。
 */

export async function POST(request: Request) {
  let body: {
    id?: string;
    message?: ChatMessage;
    model?: string;
    replaceFrom?: string;
    uiSelectedSkillIds?: string[];
  };
  try {
    body = (await request.json()) as {
      id?: string;
      message?: ChatMessage;
      model?: string;
      replaceFrom?: string;
      uiSelectedSkillIds?: string[];
    };
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const threadId = body.id ?? randomUUID();
  if (!isValidThreadId(threadId)) {
    return new Response("Bad Request", { status: 400 });
  }
  const incoming = body.message ? normalizeAttachmentParts(body.message) : undefined;

  const hasUserMessage = Boolean(incoming && incoming.role === "user");

  // 模型选择：优先用请求带的 model，然后 thread 持久化的 model，最后默认
  const requestedModel = body.model;
  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    return jsonError(500, "internal_error", "服务器内部错误");
  }

  // owner guard：按当前用户解析 thread。前端首屏会先生成一个候选 id 再发首条消息，
  // 所以「请求带 id 但查不到 owned thread」不一定是越权；只有该 id 已存在且不属于
  // 当前用户时才 404。id 不存在则允许作为新 thread 创建。
  let existingThread = await getThreadByIdForUser(threadId, currentUser.id);
  const anyThread =
    body.id && !existingThread ? await getThreadByIdIncludingDeleted(threadId) : null;
  const guard = assertThreadVisible(body.id !== undefined, existingThread, anyThread);
  if (guard) return guard;

  // P1 修复（05 QA P1-1 完整化）：QA gate 连续失败熔断后的 thread 拒绝继续执行。
  // gate 连续失败超限 → reviewState=needs_human_review(见 lib/qa/gate.ts)。
  // 此处拦截该状态的 thread 继续跑 agent,防"改一点→gate再失败→再改"无限烧 token。
  // 人工审核后在 Studio 重置 reviewState=null 恢复。
  if (existingThread?.reviewState === "needs_human_review") {
    return Response.json(
      {
        ok: false,
        error:
          "QA gate 连续失败已达上限，thread 已转人工审核。请人工核查后在 Studio 重置审核状态。",
        needsHumanReview: true,
      },
      { status: 423 }, // 423 Locked:资源被锁,需人工介入解锁
    );
  }

  // V6-M2-1: 并发 run 防护（G2/A2）—— 同 thread 已有活跃 run 时拒绝新请求。
  // 仅对有 user message 的新 run 生效，审批恢复路径（!hasUserMessage）放行。
  if (hasUserMessage) {
    const activeRun = getActiveRunForThread(threadId);
    if (activeRun) {
      return Response.json(
        {
          ok: false,
          error: "当前会话已有运行中的任务，请等待完成或取消后重试",
          runId: activeRun.runId,
        },
        { status: 409 },
      );
    }
    // P1-11:内存无活跃 run 时查 DB——进程重启后旧 run 在 DB 卡 running(孤儿,reaper 5min 才扫),
    // 不查 DB 会起第二个 run 并发写同一 workspace。DB 有活跃 run 但内存无对应 LiveRun → 判定孤儿,
    // failThreadRun 释放后放行新 run(CAS 仅活跃态可迁,已终态则无副作用)。
    const dbActiveRun = await getActiveThreadRun(threadId);
    if (dbActiveRun && !getActiveRunForThread(threadId)) {
      await failThreadRun(dbActiveRun.id, "orphan_on_new_run").catch(() => {});
    }
  }

  // V3.1：审批恢复路径。无新 user message 时，仅当 thread 处于 awaiting_approval
  // 且有已决议审批才可恢复（用户在 Studio 审批后，前端重发 chat）。
  // maxDuration=60 无法支撑人工审批阻塞，故 ask 时 fail-fast 结束 step，审批后重发恢复。
  let isResumeApproved = false;
  if (!hasUserMessage) {
    const latestResolved = await getLatestResolvedApprovalByThread(threadId);
    const resume = decideApprovalResume({
      threadStatus: existingThread?.status,
      latestResolved,
    });
    if (!resume.resume) {
      return new Response("Missing user message", { status: 400 });
    }
    if (resume.kind === "denied") {
      // 审批被拒：回 idle + 注入 system message，不重入 streamText（不重试同工具）
      await appendThreadEvent(threadId, "agent.status_changed", {
        from: "awaiting_approval",
        to: "idle",
        reason: "approval_denied",
      });
      await updateThreadStatus(threadId, "idle", ["awaiting_approval"]);
      await saveMessages([
        {
          id: randomUUID(),
          threadId,
          role: "system",
          parts: [{ type: "text", text: "操作审批被拒，请换一种方式继续。" }],
        },
      ]);
      return Response.json({ ok: false, denied: true, approvalId: resume.approvalId });
    }
    // approved：审批 API 已写 approval_resolved；这里只恢复执行，重入 streamText（模型重试工具 → allow）
    isResumeApproved = true;
  }

  const threadModel = existingThread?.model ?? aiConfig.chatModel;
  const modelId =
    requestedModel && (await isValidModelId(requestedModel)) ? requestedModel : threadModel;

  if (!existingThread) {
    // C-1: 首条消息——先用占位标题落库（不截断首条消息当标题），再并行触发 LLM 生成 6-12 字标题。
    // 标题与对话两次 AI 并行：标题 fire-and-forget 不阻塞下方 enqueue 对话 run；
    // 生成完成后 updateGeneratedTitle 落库，经 SSE/列表刷新到达侧栏。
    await saveThread({ id: threadId, userId: currentUser.id, title: "新会话", model: modelId });
    existingThread = await getThreadByIdForUser(threadId, currentUser.id);
    if (!existingThread) {
      return new Response("Thread Not Found", { status: 404 });
    }
  } else if (
    requestedModel &&
    (await isValidModelId(requestedModel)) &&
    requestedModel !== existingThread.model
  ) {
    // 切换模型时持久化
    await updateThreadModel(threadId, requestedModel);
  }

  // C-1: 只要标题还是默认占位就触发标题生成（兼容前端提前创建 thread 的场景）。
  // 前端新建会话时会先 POST /api/threads 落库，导致此处 existingThread 已存在，
  // 原来放在 !existingThread 分支里的标题生成永远走不到。

  // 更宽松的触发条件（不仅限于"新会话"）
  const shouldGenerateTitle =
    !existingThread.title ||
    existingThread.title === "新会话" ||
    existingThread.title.trim() === "" ||
    existingThread.title.startsWith("新会话");

  console.log("[Chat Route] 标题生成检查", {
    threadId,
    currentTitle: existingThread.title,
    shouldGenerateTitle,
    hasIncoming: !!incoming,
  });

  if (shouldGenerateTitle && incoming) {
    const firstMessageText = getTextFromMessage(incoming);

    console.log("[Chat Route] 准备生成标题", {
      threadId,
      firstTextPreview: firstMessageText.slice(0, 50),
      hasText: !!firstMessageText.trim(),
      modelId,
    });

    void generateThreadTitle(threadId, firstMessageText, modelId)
      .then((title) => {
        // 注意：generateThreadTitle内部不返回title，这里只是标记成功
        console.log("[Chat Route] ✅ 标题生成流程完成", { threadId });
      })
      .catch((err) => {
        console.error("[Chat Route] ❌ 标题生成失败", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        logger.warn("[chat] 首条消息标题生成失败（fail-open，不影响对话）", {
          threadId,
          error: String(err),
        });
      });
  } else if (!incoming) {
    console.warn("[Chat Route] 跳过标题生成：无incoming消息");
  } else {
    console.log("[Chat Route] 跳过标题生成：标题已存在", { currentTitle: existingThread.title });
  }

  // 标记线程为执行中（Phase 2 §8.1：先追加事件 → 再投影更新）
  const fromStatus = existingThread?.status ?? "idle";
  await appendThreadEvent(threadId, "agent.started", {
    reason: isResumeApproved ? "approval_resumed" : "user_message_received",
  });
  await appendThreadEvent(threadId, "agent.status_changed", {
    from: fromStatus,
    to: "executing",
    reason: isResumeApproved ? "approval_approved" : "chat_started",
  });
  await Promise.all([
    updateThreadStatus(threadId, "executing"),
    updateThreadPreviewUrl(threadId, null),
  ]);

  // V8：Run 级 Skill Resolver。每次用户消息触发 run 时独立解析是否使用 Skill；
  // 恢复未完成 run 时沿用原 run 的 ThreadRunSkill（约束 6）。
  // 不再从 thread 固化读取（getActiveSkillForThread），不回填 thread（setThreadSkill），
  // 不回退默认 build-from-idea——无匹配时使用 AGENT_SYSTEM_PROMPT 基础 agent。
  // 审计修复：从 status="executing" 到 enqueue 之间的所有准备代码用 try/catch 包裹。
  // 任何未处理异常都回滚 thread 状态到 fromStatus，防止 thread 永久卡在 "executing"。
  const runId = randomUUID(); // 预生成 runId 供 Resolver 审计和 ThreadRunSkill 落库
  let resolverOutput: SkillResolverOutput;
  // V8：availableSkillCount 供 ContextSnapshot 记录 Resolver 输入摘要
  let availableSkillCount = 0;
  // V8 补充方案阶段 3：availableSkills 提升到外层，供第二段 try 装配 SkillRuntimeContext 查 SkillSummary。
  let availableSkills: SkillSummary[] = [];
  try {
    // resume 路径：审批恢复时沿用原 run 的 SkillVersion（约束 6）
    let resumeFromRunId: string | undefined;
    let resumedSkillVersions: SelectedSkillVersion[] | undefined;
    if (isResumeApproved) {
      const prevRun = await getLatestThreadRun(threadId);
      if (prevRun) {
        const prevSkills = await listThreadRunSkillsByRun(prevRun.id);
        resumedSkillVersions = prevSkills.map((r) => ({
          skillId: r.skillId,
          skillVersionId: r.skillVersionId,
          // DB role 列为 varchar，收窄为 SkillRole（只可能由本系统写入 primary/supporting）
          role: r.role as SkillRole,
          source: "resume",
          reason: r.reason ?? "resume",
          contentHash: r.contentHash,
        }));
        resumeFromRunId = prevRun.id;
      }
    }

    // 加载可用 Skill 候选（企业 Skill 平台 / 本地 DB Provider）
    const provider = getSkillProvider();
    availableSkills = await provider.listAvailableSkills();
    availableSkillCount = availableSkills.length;

    // 提取用户消息文本 + 附件文件名（resume 路径无 incoming，text 为空）
    const userText = incoming ? getTextFromMessage(incoming) : "";
    const attachmentFilenames = incoming
      ? (incoming.parts ?? [])
          .filter(
            (p) =>
              p.type === "data-attachment" &&
              typeof (p as { data?: { filename?: string } }).data?.filename === "string",
          )
          .map((p) => (p as { data: { filename: string } }).data.filename)
      : [];

    resolverOutput = resolveSkillForRun({
      threadId,
      runId,
      userMessage: { text: userText, attachmentFilenames },
      uiSelectedSkillIds: body.uiSelectedSkillIds ?? [],
      availableSkills,
      resumeFromRunId,
      resumedSkillVersions,
    });

    if (resolverOutput.ignoredUiSelectedSkillIds.length > 0) {
      logger.info("[chat] UI 选择的 skill 部分被忽略", {
        threadId,
        ignored: resolverOutput.ignoredUiSelectedSkillIds,
        reason: resolverOutput.decisionReason,
      });
    }
  } catch (error) {
    // Resolver 失败不阻塞 chat，回退基础 agent
    logger.warn("[chat] Skill Resolver 失败，回退基础 agent", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    resolverOutput = {
      selectedSkillVersions: [],
      decisionReason: "resolver_error（回退基础 agent）",
      ignoredUiSelectedSkillIds: body.uiSelectedSkillIds ?? [],
    };
  }

  // 准备阶段：从 Resolver 输出加载选中 Skill → 装配 system prompt / tools / 上下文 →
  // 创建 ThreadRun + 落库 ThreadRunSkill + 记录 ContextSnapshot + enqueue。
  // 审计修复：整段用 try/catch 包裹，任何未处理异常回滚 thread 状态到 fromStatus。
  try {
    // 02 文档 §六.2：从 Resolver 输出装配 SkillRuntimeContext（只本地分支）。
    // Resolver 选中的 Skill 一定是本地 DB 行（本地自建或同步镜像），从 DB 装载完整版本信息。
    // summary 未找到（skill 已下线 / resume 时不可用）→ fail-closed 回退基础 agent。
    const primarySelection = resolverOutput.selectedSkillVersions[0] ?? null;
    let runtimeContext: SkillRuntimeContext | null = null;
    if (primarySelection) {
      const summary = availableSkills.find((s) => s.skillId === primarySelection.skillId) ?? null;
      if (summary) {
        // 查 DB 装载完整 Skill/SkillVersion 行（懒加载：只有选中的才读 DB）
        const [skillRow, versionRow] = await Promise.all([
          getSkillById(primarySelection.skillId),
          getSkillVersion(primarySelection.skillVersionId),
        ]);
        if (skillRow && versionRow) {
          const requiredCapabilities = Array.isArray(versionRow.requiredCapabilities)
            ? (versionRow.requiredCapabilities as string[])
            : [];
          runtimeContext = {
            source: skillRow.source,
            skillId: skillRow.id,
            skillVersionId: versionRow.id,
            name: skillRow.name,
            description: skillRow.description ?? "",
            commitSha: versionRow.commitSha ?? null,
            promptTemplate: versionRow.promptTemplate,
            completionCriteria: versionRow.completionCriteria,
            defaultModelProfile: versionRow.defaultModelProfile,
            runtimeType: versionRow.runtimeType,
            requiredCapabilities,
            version: String(versionRow.version),
            contentHash: versionRow.commitSha,
          };
        }
      } else {
        // summary 未找到：skill 已下线 / resume 时不可用 → fail-closed
        logger.warn("[chat] 选中 Skill 在 availableSkills 中未找到，回退基础 agent", {
          threadId,
          skillId: primarySelection.skillId,
          availableSkillCount,
        });
      }
    }

    const systemPrompt = runtimeContext
      ? composeSkillSystemPrompt({
          skill: { name: runtimeContext.name, description: runtimeContext.description },
          version: {
            commitSha: runtimeContext.commitSha,
            promptTemplate: runtimeContext.promptTemplate,
            completionCriteria: runtimeContext.completionCriteria,
            hasSkillFile: Boolean(runtimeContext.commitSha),
          },
        })
      : AGENT_SYSTEM_PROMPT;
    // V8 阶段 6：Skill 的 allowedTools 不再作为工具可见性边界（工具权限交给 permission policy）。
    // buildTools 不再因 SkillVersion.allowedTools 过滤工具；chat 路径传 undefined = 全部工具可见。
    // requiredCapabilities 仅用于 Resolver 判断和 Studio 提示，不影响工具可见性。
    // Phase 5 Stage E：解析 runtimeType（thread → skill → 全局默认），透传 buildTools
    const runtimeType = resolveRuntimeTypeForThread(existingThread, {
      runtimeType: runtimeContext?.runtimeType ?? null,
    });
    // skill 加载上下文：02 文档 §六.3，readSkillFile 只读本地 commitSha 快照。
    // 有 commitSha → 挂 readSkillFile 读 git 快照；无 commitSha → 迁移期旧版本，不挂 readSkillFile。
    // 附带 skillVersionId + evidence 累积器，readSkillFile 读取时记录加载证据，
    // 运行结束由 thread-runner flush 到 ContextSnapshot.skillLoadEvidence。
    let skillContext: SkillContext | undefined;
    if (runtimeContext?.commitSha) {
      skillContext = {
        source: "local",
        name: runtimeContext.name,
        commitSha: runtimeContext.commitSha,
        skillVersionId: runtimeContext.skillVersionId,
        evidence: [] as SkillLoadEvidenceEntry[],
      };
    }

    // V3.4 Stage D：异步加载 DB 中启用的自定义工具，注入 agent 可见工具集。
    // 加载失败不阻塞 chat（fail-open），空数组 → 无自定义工具（零回归）。
    let customDeclarations: CustomToolDeclaration[] = [];
    try {
      customDeclarations = normalizeCustomToolDeclarations(await listEnabledCustomTools());
    } catch (error) {
      logger.error("加载自定义工具失败（fail-open，不阻塞 chat）", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // V8 阶段 6：chat 路径不再传 allowedTools（工具可见性不再受 Skill 限制）。
    // 工具安全边界由 permission policy（fail-closed）处理，与 Skill 声明正交。
    const tools = buildTools(threadId, undefined, runtimeType, skillContext, customDeclarations);
    // §6.5：skill.defaultModelProfile 作为最低优先级模型候选（低于请求 / thread 已选 model）
    // 本地自建与同步镜像 Skill 均可声明 defaultModelProfile
    let effectiveModelId = modelId;
    if (
      runtimeContext?.defaultModelProfile &&
      !requestedModel &&
      !existingThread?.model &&
      (await isValidModelId(runtimeContext.defaultModelProfile))
    ) {
      effectiveModelId = runtimeContext.defaultModelProfile;
    }

    // V3.1：恢复路径无新 user message（用既有 history 重入 streamText），跳过用户消息持久化
    if (!isResumeApproved && incoming) {
      // 编辑最后一条 user 消息重新生成：前端通过 replaceFrom 告知被替换的旧消息 id。
      // 先删除该消息及其之后的所有消息（旧 user 消息 + 旧 assistant 回复），
      // 再写入新 user 消息，保证 DB 与前端 setMessages(truncated) 对齐，避免刷新后重复。
      if (body.replaceFrom) {
        await deleteMessagesFromId(threadId, body.replaceFrom);
      }
      await saveMessages([{ id: incoming.id, threadId, role: "user", parts: incoming.parts }]);
    }
    const history = convertToUIMessages(await getMessagesByThreadId(threadId));

    // S1 修复（03-P1-6）：解析 /clear + @file 命令。
    // - /clear：跳过 history 注入（effectiveHistory=[]），从本条消息起重置上下文。
    // - @file <path>：读取工作区文件内容，作为 context layer 注入模型输入（不修改已保存的用户消息）。
    let contextClear = false;
    let fileInjectionNote: string | null = null;
    if (incoming) {
      const incomingText = (incoming.parts ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text" && "text" in p)
        .map((p) => p.text)
        .join("\n");
      const cmds = parseContextCommands(incomingText);
      contextClear = cmds.clear;
      if (cmds.fileRefs.length > 0) {
        const fileContents: string[] = [];
        for (const ref of cmds.fileRefs) {
          const content = await readWorkspaceFile(threadId, ref).catch(() => null);
          if (content !== null) {
            fileContents.push(`@file ${ref}:\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``);
          }
        }
        if (fileContents.length > 0) fileInjectionNote = fileContents.join("\n\n");
      }
    }
    // /clear：仅保留最后一条（当前用户消息），丢弃之前的全部上下文，从本条起重置。
    const effectiveHistory = contextClear ? history.slice(-1) : history;

    // V3.3a：主动装配上下文包。低于预算阈值且无其它触发 → buildContextPackage 逐字直通
    // convertToModelMessages(history)（零回归）；超阈值 / 超大工具输出 / plan 阶段切换 /
    // verifying-delivering → 旧消息区段替换为结构化摘要，protected 集合硬保留。
    // fail-safe：builder 抛错 → assembleModelMessages 回退直通 + log，压缩 bug 不让 chat 500。
    const tokenBudget = resolveTokenBudget(effectiveModelId);
    const threadStatus = existingThread?.status ?? "idle";

    // V6-M2-4: critical 拒绝追加（G5/C1）—— 上下文达临界线时拒绝追加新消息/工具输出
    // 在 memory retrieval 和 assembleModelMessages 之前快速拦截，避免浪费 token。
    // 用同步 estimateMessagesTokens（budget=Infinity 时 Number.isFinite=false → 跳过）。
    if (Number.isFinite(tokenBudget) && tokenBudget > 0) {
      const usedTokens = estimateMessagesTokens(effectiveHistory);
      const criticalRatio = usedTokens / tokenBudget;
      if (criticalRatio >= contextConfig.criticalThreshold) {
        // 回滚线程状态：status 已在上方设为 "executing"，但 run 未实际入队，须恢复
        await appendThreadEvent(threadId, "agent.status_changed", {
          from: "executing",
          to: fromStatus,
          reason: "context_critical_rejected",
        }).catch(() => {});
        await updateThreadStatus(threadId, fromStatus).catch(() => {});
        return Response.json(
          {
            ok: false,
            error: {
              code: "context_critical",
              message:
                "会话上下文已达临界阈值，无法继续追加消息。请开始新会话或使用 /clear 重置上下文。",
              usedTokens,
              tokenBudget,
              loadLevel: "critical",
            },
          },
          { status: 413 },
        );
      }
    }

    // V3.3b Stage C：检索长期记忆（lexical + semantic rerank），注入 builder 与 manifest。
    // resolveEmbeddingProvider() 在无配置时自动返回 DisabledEmbeddingProvider，保持可观测降级。
    // 无记忆时 builder 零回归（逐字一致）；retrieve fail-open 不阻断 chat（catch → 空 memories）。
    let memResult: Awaited<ReturnType<typeof retrieveMemories>>;
    try {
      // P0 修复（memory project scope）：thread 关联 projectId 时增加 project scope 检索，
      // 让 agent 写入的 project 级记忆能被召回（与 rememberFact 工具能力对齐）。
      // projectId 为 null 时仅查 user + thread（零回归）。
      const scopes: Array<{ scope: MemoryScope; scopeRef: string | null }> = [
        { scope: "user", scopeRef: currentUser.id },
        { scope: "thread", scopeRef: threadId },
      ];
      const threadProjectId = existingThread?.projectId ?? null;
      if (threadProjectId) {
        scopes.push({ scope: "project", scopeRef: threadProjectId });
      }
      memResult = await retrieveMemories({
        scopes,
        currentGoal: latestUserText(history),
        embeddingProvider: resolveEmbeddingProvider(),
      });
    } catch (error) {
      logger.error("retrieveMemories 失败（fail-open，空 memories）", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      memResult = {
        memories: [],
        lexicalCandidates: [],
        embedding: { provider: "none", status: "error", reranked: false },
      };
    }
    const memories = memResult.memories;
    const assembled = await assembleModelMessages({
      threadId,
      history,
      build: async () => {
        // 始终加载 toolRuns：用于超大工具输出触发 + recentFailure。短 thread 零回归路径
        // 下 builder 仍逐字直通（消息不变），仅多一次轻量查询。
        const toolRuns = await listToolRunsByThread(threadId);
        const recentFailure = toolRuns.find((tr) => tr.status === "failed") ?? null;
        const budgetExceeded = shouldCompress(
          estimateMessagesTokens(effectiveHistory),
          tokenBudget,
        );
        const oversized = toolRuns.some(
          (tr) =>
            estimateTokens(JSON.stringify(tr.output ?? "")) > contextConfig.toolOutputThreshold,
        );
        // 仅在可能压缩时才加载完整 protected 上下文 + 事件（plan/approval/events）。
        if (!budgetExceeded && !oversized) {
          // P0 修复（pinned facts 持久化）：始终加载 pinned facts 注入 protected（即使不压缩）。
          // pinned facts 是用户明确要求保留的事实,任何压缩后必须仍出现。
          const pinnedFacts = await getPinnedFacts(threadId);
          return buildContextPackage({
            threadId,
            model: effectiveModelId,
            history: effectiveHistory,
            tokenBudget,
            toolRuns,
            recentFailure,
            threadStatus,
            memories,
            pinnedFacts: pinnedFacts.length > 0 ? pinnedFacts : undefined,
          });
        }
        const [activePlan, pendingApprovals, events, pinnedFacts] = await Promise.all([
          getActiveThreadPlan(threadId),
          getPendingApprovalsByThread(threadId),
          listThreadEvents(threadId),
          getPinnedFacts(threadId),
        ]);
        const planEvents = events.filter((e) => e.type.startsWith("plan."));
        const statusChanges = events
          .filter((e) => e.type === "agent.status_changed")
          .map((e) => e.payload as { reason?: string; to?: string });
        return buildContextPackage({
          threadId,
          model: effectiveModelId,
          history: effectiveHistory,
          tokenBudget,
          toolRuns,
          recentFailure,
          activePlan,
          pendingApprovals,
          planEvents,
          statusChanges,
          threadStatus,
          memories,
          pinnedFacts: pinnedFacts.length > 0 ? pinnedFacts : undefined,
        });
      },
    });
    const modelMessages = assembled.messages;

    // S1 修复（03-P1-6）：@file 注入 —— 把引用文件内容作为 context layer 前置到模型输入。
    // 不修改已保存的用户消息（保留 @file 原文供审计），仅向模型注入文件参考内容。
    if (fileInjectionNote) {
      modelMessages.unshift({
        role: "user",
        content: `系统注入的文件参考内容，不是新的用户请求：\n\n${fileInjectionNote}`,
      });
    }

    // S1 修复（06-P1-3）：文件级项目记忆（CLAUDE.md/SNOW.md/AGENTS.md）注入。
    // 对标 Claude Code CLAUDE.md，作为 protected context note 前置（不受压缩裁剪）。
    try {
      const { loadProjectMemoryFiles } = await import("@/lib/memory/project-files");
      const projectMemory = await loadProjectMemoryFiles(threadId);
      if (projectMemory) {
        modelMessages.unshift({
          role: "user",
          content: `系统注入的项目记忆（CLAUDE.md 类文件），不是新的用户请求：\n\n${projectMemory}`,
        });
      }
    } catch {
      // best-effort：读取失败不阻断 chat
    }

    // V3.5 Stage D：把已完成子代理的 summary 作为 context layer 注入父模型输入。
    // 只注入 summary（不含 transcript），让父 agent 在下一轮看到子代理结果。无子代理 → 零回归。
    let subagentLayerCount = 0;
    try {
      const runs = await listSubagentRunsByThread(threadId);
      const completed = runs.filter((r) => r.status === "completed");
      if (completed.length > 0) {
        const summaries = await Promise.all(completed.map((r) => buildSubagentSummary(r)));
        const section = renderSubagentSummaries(summaries);
        if (section) {
          subagentLayerCount = completed.length;
          modelMessages.unshift({
            role: "user",
            content: `系统提供的子代理结果汇总，不是新的用户请求：\n\n${section}`,
          });
        }
      }
    } catch (error) {
      logger.error("子代理 summary 注入失败（fail-open，不阻断 chat）", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // V7 S1-3：先创建 ThreadRun 事实源记录。V8：runId 在 Resolver 前预生成，
    // 此处传入 id 让 DB 记录与 Resolver 审计 / ThreadRunSkill / enqueue 一致。
    startReaper(); // 幂等：进程内只启动一个 reaper（B-2）
    const triggerType = isResumeApproved ? "approval_resume" : "user_message";
    await createThreadRun({
      id: runId,
      threadId,
      model: effectiveModelId,
      triggerType,
      triggerMessageId: incoming?.id,
      // 旧字段仅作兼容展示；权威 Skill 记录在 ThreadRunSkill（下方落库）。
      // V8 补充方案阶段 3：skillId/skillVersionId 来自 SkillRuntimeContext（支持企业无本地行）。
      skillId: runtimeContext?.skillId,
      skillVersionId: runtimeContext?.skillVersionId,
      runtimeType,
      status: "running",
    });

    // V8：ThreadRunSkill 先落库再执行（方案 §六.3）。
    // 即使后续 enqueue 失败或 run 中断，本轮 Resolver 决策仍可复盘。
    // 空数组（基础 agent）不落行，保持 0 行 = 无 Skill 的事实语义。
    await saveThreadRunSkills({
      runId,
      threadId,
      skills: resolverOutput.selectedSkillVersions.map((v) => ({
        skillId: v.skillId,
        skillVersionId: v.skillVersionId,
        role: v.role,
        source: v.source,
        reason: v.reason,
        contentHash: v.contentHash,
      })),
    });

    // V3.0 Stage C：每次模型调用前记录 context manifest（fail-open，不阻断 chat）。
    // V3.3a：传入 tokenBudget 与 appliedSummaryIds 供审计。
    // V8 补充方案阶段 3：skill ref 来自 SkillRuntimeContext；企业源 commitSha/requiredCapabilities/runtimeType 为 null/空。
    await recordContextSnapshot({
      threadId,
      trigger: "chat.user_message",
      model: effectiveModelId,
      runtimeType,
      runId,
      skill: runtimeContext
        ? {
            skillId: runtimeContext.skillId,
            versionId: runtimeContext.skillVersionId,
            commitSha: runtimeContext.commitSha,
            // V8 阶段 6：记录能力声明（审计用），不再记录 allowedTools 作为安全边界
            requiredCapabilities: runtimeContext.requiredCapabilities,
            runtimeType: runtimeContext.runtimeType,
          }
        : null,
      historyCount: history.length,
      visibleToolNames: Object.keys(tools),
      tokenBudget,
      appliedSummaryIds: assembled.manifest?.appliedSummaryIds ?? [],
      // V3.3b Stage 0：context manifest 必须与真实模型输入一致——透传 buildContextPackage
      // 的真实装配 manifest（compressed/afterTokens/protectedRefs/excludedCandidates），
      // 而非静态来源清单。fallback（builder 抛错）时 manifest 为 undefined → 零回归静态。
      packageManifest: assembled.manifest
        ? {
            compressed: assembled.compressed,
            beforeTokens: assembled.manifest.beforeTokens,
            afterTokens: assembled.manifest.afterTokens,
            protectedRefs: assembled.manifest.protectedRefs,
            excludedCandidates: assembled.manifest.excludedCandidates,
            appliedSummaryIds: assembled.manifest.appliedSummaryIds,
          }
        : undefined,
      // V3.3b Stage C：本轮注入的长期记忆（填 memory layer 供审计/Studio 可观测）。
      memories: memories.map((m) => ({
        id: m.id,
        scope: m.scope,
        kind: m.kind,
        textHash: m.textHash,
        retrievalScore: m.retrievalScore,
        retrievalReason: m.retrievalReason,
        semanticStatus: memResult.embedding.status,
      })),
      // V8：Resolver 输入/输出摘要写入快照供 Studio 复盘（不含完整 SKILL.md，懒加载约束）
      skillResolverInput: {
        availableSkillCount,
        uiSelectedSkillIds: body.uiSelectedSkillIds ?? [],
      },
      skillResolverOutput: {
        selectedSkillVersions: resolverOutput.selectedSkillVersions.map((v) => ({
          skillId: v.skillId,
          skillVersionId: v.skillVersionId,
          role: v.role,
          source: v.source,
        })),
        decisionReason: resolverOutput.decisionReason,
        ignoredUiSelectedSkillIds: resolverOutput.ignoredUiSelectedSkillIds,
      },
    });

    // V3.3a Stage C：压缩事件落库（fail-open，不阻断 chat）。
    // - context.summary_created：每个本轮新建的 summary。
    // - context.compressed：本轮压缩总览（appliedSummaryIds / before-after tokens / protected 数）。
    if (assembled.compressed && assembled.manifest) {
      try {
        for (const s of assembled.manifest.summaries.filter((x) => x.isNew)) {
          await appendThreadEvent(
            threadId,
            "context.summary_created",
            {
              summaryId: s.id,
              type: s.type,
              scope: s.scope,
              tokenEstimate: s.tokenEstimate,
              originalTokenEstimate: s.originalTokenEstimate,
            },
            runId,
          );
        }
        const snapshots = await listContextSnapshotsForThread(threadId, 1);
        await appendThreadEvent(
          threadId,
          "context.compressed",
          {
            snapshotId: snapshots[0]?.id ?? null,
            appliedSummaryIds: assembled.manifest.appliedSummaryIds,
            excludedCandidateCount: assembled.manifest.excludedCandidates.length,
            protectedCount: assembled.manifest.protectedRefs.length,
            beforeTokens: assembled.manifest.beforeTokens,
            afterTokens: assembled.manifest.afterTokens,
          },
          runId,
        );
      } catch (error) {
        logger.error("context 压缩事件落库失败（fail-open）", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // V4 Phase B-1：POST 不再直接返回流式 response，改为提交任务到运行管理器 → 返回 runId。
    // 前端拿到 runId 后订阅 SSE（/api/threads/[id]/stream）接收流式输出。
    // 执行生命周期由 thread-runner 托管，独立于本次 HTTP 请求 → 切走/刷新不杀执行。
    enqueue({
      runId,
      threadId,
      modelMessages,
      system: systemPrompt,
      modelId: effectiveModelId,
      tools,
      getChatModel,
      // P1-2 完整化:streamText 失败时熔断当前 endpoint,下次切备用
      markEndpointFailed: markCurrentEndpointFailed,
      // V8：传递 skillContext.evidence 累积器，运行结束 flush 到 ContextSnapshot
      skillLoadEvidence: skillContext?.evidence,
    });

    return Response.json({ ok: true, data: { runId } });
  } catch (prepareError) {
    // 审计修复：准备阶段异常 → 回滚 thread 状态到 fromStatus，防永久卡死 "executing"。
    // 与 context_critical 拒绝路径（line ~522）的 rollback 逻辑一致。
    logger.error("[chat] 准备阶段异常，回滚 thread 状态", {
      threadId,
      fromStatus,
      error: prepareError instanceof Error ? prepareError.message : String(prepareError),
    });
    await appendThreadEvent(threadId, "agent.status_changed", {
      from: "executing",
      to: fromStatus,
      reason: "prepare_error",
    }).catch(() => {});
    await updateThreadStatus(threadId, fromStatus).catch(() => {});
    // P1-2:回滚已创建的 ThreadRun 行(若已落库),防永久卡 running 被虚假活跃 5min 才被 reaper 标 stale。
    // createThreadRun 之前抛错时 runId 未落库,failThreadRun 的 CAS WHERE 匹配 0 行,无副作用。
    await failThreadRun(runId, "prepare_error").catch(() => {});
    return Response.json({ ok: false, error: "服务器内部错误，请重试" }, { status: 500 });
  }
}
