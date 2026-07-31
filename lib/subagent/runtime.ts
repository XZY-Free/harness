import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { runInSubagentScope } from "@/lib/ai/tool-runtime";
import { backgroundTaskConfig } from "@/lib/config";
import {
  getActiveThreadPlan,
  getMessagesByThreadId,
  getThreadById,
  listThreadPlanItems,
  listToolRunsByThread,
  updateSubagentRun,
} from "@/lib/db/queries";
import type { SubagentDefinition, SubagentRun } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { resolveRuntimeTypeForThread } from "@/lib/runtime/registry";
import { redactText } from "@/lib/runtime/secret-redaction";
import { type SubagentContextPolicy, buildSubagentContextPackage } from "@/lib/subagent/context";
import { getDefinition, getRun, updateRunStatus, validateOutput } from "@/lib/subagent/registry";
import { buildSubagentTools } from "@/lib/subagent/tool-scope";
import type { ModelMessage, ToolSet } from "ai";

/**
 * V3.5 Stage C：子代理嵌套执行 runtime。
 *
 * 子代理执行 = 进程内嵌套 generateText 循环（streamText 的非流步等价，适合嵌套同步执行）
 * + SubagentRun DB 行做审计/状态 + transcript 落 artifact 文件（不进父 Message 表）。
 *
 * 命门（计划执行规矩 §3）：
 * - transcript 不进父 Message 表：executeSubagent 只写 SubagentRun + transcript artifact 文件，
 *   绝不调 saveMessages。joinSubagent 只回 { result, summary, outputArtifactId }。
 * - 失败不崩父：异常在 executeSubagent 内捕获 → status=failed/timed_out；不向上抛。
 * - 嵌套深度=1：子代理工具集硬剥离 spawnSubagent/joinSubagent（buildSubagentTools 的 allowedTools
 *   白名单已不含它们，此处再剥一层 defense-in-depth），子代理无法再 spawn。
 * - 子代理独立 stop 条件：step 上限 12 + 超时；outputSchema 在外层 loop 手动校验（AI SDK stopWhen
 *   不直接检测 schema 合规，故 generateText 跑完后校验最终输出）。
 */

/** 子代理 step 上限（不复用父 stepCountIs(24)，子代理任务更短）。 */
export const SUBAGENT_MAX_STEPS = 12;
/** 子代理执行超时（ms）。 */
export const SUBAGENT_TIMEOUT_MS = 120_000;

/** 子代理系统 prompt：约束其只读探索/研究/审查/验证，产出符合 outputSchema 的结构化结果。 */
export const SUBAGENT_SYSTEM_PROMPT = [
  "你是 SnowHarness 的子代理（subagent），由父 agent 派生执行一个有界工作单元。",
  "你只看到父 agent 提供的裁剪上下文（目标 + 提示 + 相关片段），看不到父的完整历史。",
  "你的工具受 allowedTools 限制，写操作受 writeScope 限制；默认只读。",
  "你不可再派生子代理（嵌套深度=1）。",
  "完成时输出符合 outputSchema 的结构化结果（JSON）。不要输出无关闲聊。",
].join("\n");

/** 可注入的模型执行器（测试用 fake；默认走 generateText）。 */
export type SubagentModelRunner = (args: {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  /** S1 修复（01-P2-4）：用 SDK 的 ToolSet 类型替代 Record<string, unknown>，消除 as never。 */
  tools: ToolSet;
  maxSteps: number;
  abortSignal?: AbortSignal;
}) => Promise<{ text: string; finishReason: string }>;

/** transcript 写入器（可注入；默认写 .snow/runtime/{threadId}/subagents/{runId}/transcript.json）。 */
export type TranscriptWriter = (args: {
  parentThreadId: string;
  runId: string;
  data: unknown;
}) => Promise<string>;

/** 默认 transcript 写入：落 artifact 文件，返回相对路径。 */
const defaultTranscriptWriter: TranscriptWriter = async ({ parentThreadId, runId, data }) => {
  const rel = `.snow/runtime/${parentThreadId}/subagents/${runId}/transcript.json`
    .split("/")
    .join(sep);
  const abs = join(backgroundTaskConfig.hostLogDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  // S1（04-G13）：transcript 体积上限（默认 2MB），超限截断 messages 等大字段防磁盘膨胀。
  const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
  let payload = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(payload, "utf8") > MAX_TRANSCRIPT_BYTES) {
    const capped = { ...(data as Record<string, unknown>) };
    // messages 通常是最大字段，截断 + 标记
    if (Array.isArray(capped.messages)) {
      capped.messages = `[...transcript 过大（${MAX_TRANSCRIPT_BYTES} 字节上限），messages 已截断...]`;
    }
    payload = JSON.stringify(capped, null, 2).slice(0, MAX_TRANSCRIPT_BYTES);
  }
  await writeFile(abs, payload, "utf8");
  return rel;
};

/** 默认模型执行器：generateText + stepCountIs 上限。 */
const defaultModelRunner: SubagentModelRunner = async (args) => {
  const { generateText, stepCountIs } = await import("ai");
  const { getChatModel } = await import("@/lib/ai/provider");
  // S1 修复（01-P2-4）：tools 用 ToolSet 类型直接传入，消除 as never。
  // 返回值 result 为 GenerateTextResult，直接取 text/finishReason。
  const result = await generateText({
    model: getChatModel(args.modelId),
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    abortSignal: args.abortSignal,
    stopWhen: stepCountIs(args.maxSteps),
  });
  return { text: result.text, finishReason: result.finishReason };
};

/** 可替换的模型执行器（测试注入 fake；默认 defaultModelRunner）。 */
let modelRunner: SubagentModelRunner = defaultModelRunner;
/** 可替换的 transcript 写入器（测试注入 fake）。 */
let transcriptWriter: TranscriptWriter = defaultTranscriptWriter;

/** 测试注入模型执行器。传 undefined 恢复默认。 */
export function setSubagentModelRunner(fn: SubagentModelRunner | null): void {
  modelRunner = fn ?? defaultModelRunner;
}
/** 测试注入 transcript 写入器。传 undefined 恢复默认。 */
export function setSubagentTranscriptWriter(fn: TranscriptWriter | null): void {
  transcriptWriter = fn ?? defaultTranscriptWriter;
}

/** 子代理工具集必须剥离的「再 spawn」能力工具（嵌套深度=1，defense-in-depth）。 */
const FORBIDDEN_IN_SUBAGENT = new Set(["spawnSubagent", "joinSubagent"]);

/** S1 修复（01-P2-4）：用 ToolSet 类型保留 SDK 工具类型信息，消除 as never。 */
function stripSpawnTools(tools: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!FORBIDDEN_IN_SUBAGENT.has(name)) out[name] = t;
  }
  return out;
}

/** 解析子代理模型 id：definition.modelProfileId 或继承父 thread.model。 */
async function resolveSubagentModelId(
  definition: SubagentDefinition,
  parentThreadId: string,
): Promise<string> {
  if (definition.modelProfileId) return definition.modelProfileId;
  // 继承父：读 thread.model；缺省回 aiConfig.chatModel
  const { aiConfig } = await import("@/lib/config");
  const thread = await getThreadById(parentThreadId);
  return thread?.model ?? aiConfig.chatModel;
}

async function resolveSubagentRuntimeType(parentThreadId: string) {
  // V8 阶段 8：不再从 thread.activeSkillId 解析 Skill runtimeType（Skill 不再绑定 thread）
  const thread = await getThreadById(parentThreadId);
  return resolveRuntimeTypeForThread(thread, null);
}

/** 在 includeHistory=true 时构造父历史摘要（已裁剪/脱敏，非原始 Message 表）。 */
async function buildParentHistorySummary(
  parentThreadId: string,
  policy: SubagentContextPolicy,
): Promise<string | undefined> {
  if (!policy.includeHistory) return undefined;
  const maxMessages = policy.maxHistoryMessages ?? 10;
  const messages = await getMessagesByThreadId(parentThreadId);
  const recent = messages.slice(-maxMessages);
  if (recent.length === 0) return undefined;
  const lines = recent.map((m) => {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const rawText = parts
      .map((p: unknown) => {
        if (
          p &&
          typeof p === "object" &&
          "text" in p &&
          typeof (p as { text: unknown }).text === "string"
        ) {
          return (p as { text: string }).text;
        }
        return "";
      })
      .join(" ");
    // 审计修复：先脱敏后截断（原先截断后脱敏，截断边界的部分 secret
    // 无法被正则匹配，导致部分密钥明文进入子代理上下文）。
    const text = redactText(rawText, parentThreadId).slice(0, 200);
    return `[${m.role}] ${text}`;
  });
  return lines.join("\n");
}

/** 尝试解析输出为 JSON；非 JSON 则原样字符串返回（outputSchema 可能接受 string）。 */
function tryParseOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 落到非 JSON 分支
    }
  }
  return text;
}

/**
 * 执行一个子代理 run（queued→running→completed/failed/timed_out）。
 *
 * 异常/超时在内部收敛为终态，**不向上抛**（失败不崩父）。
 * transcript 落 artifact 文件，绝不写父 Message 表。
 */
export async function executeSubagent(
  runId: string,
  options?: {
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    /** S1（04-G4）：per-run maxSteps 覆盖（默认 SUBAGENT_MAX_STEPS）。 */
    maxSteps?: number;
  },
): Promise<SubagentRun | null> {
  const run = await getRun(runId);
  if (!run) return null;
  // 非 queued（已被并发启动或终态）→ 直接返回，不重复执行
  if (run.status !== "queued") return run;

  const definition = await getDefinition(run.definitionId);
  if (!definition) {
    await updateRunStatus(runId, "failed", { errorMessage: "definition 不存在" });
    return getRun(runId);
  }

  await updateRunStatus(runId, "running");

  const timeoutMs = options?.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
  // S1（04-G4）：per-run maxSteps 覆盖
  const maxSteps = options?.maxSteps ?? SUBAGENT_MAX_STEPS;
  let timedOut = false;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
  // 审计修复 M2：保存 setTimeout 句柄，在 finally 中 clear（原代码未 clear，
  // 子代理完成后 120s 定时器仍留在事件循环，高并发下定时器队列饱和导致延迟）。
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`子代理执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  try {
    const policy = (definition.contextPolicy ?? {}) as SubagentContextPolicy;
    const runtimeType = await resolveSubagentRuntimeType(run.parentThreadId);
    const activePlan = policy.includePlan ? await getActiveThreadPlan(run.parentThreadId) : null;
    const [parentHistorySummary, planItems, recentToolEvidence, modelId] = await Promise.all([
      buildParentHistorySummary(run.parentThreadId, policy),
      policy.includePlan
        ? activePlan
          ? listThreadPlanItems(run.parentThreadId, activePlan.id)
          : Promise.resolve([])
        : Promise.resolve([]),
      policy.includeToolEvidence
        ? listToolRunsByThread(run.parentThreadId, Math.max(policy.maxSnippets ?? 5, 5))
        : Promise.resolve([]),
      resolveSubagentModelId(definition, run.parentThreadId),
    ]);

    // 1. 装配 scoped 上下文（合成消息，不含父历史；includeHistory 时注入已裁剪摘要）
    const contextPkg = await buildSubagentContextPackage({
      parentThreadId: run.parentThreadId,
      goal: run.goal,
      contextHints: (run.contextHints as string[] | null) ?? undefined,
      definition,
      activePlan,
      planItems,
      recentToolEvidence,
      model: modelId,
      parentHistorySummary,
    });

    // 2. 装配子代理工具（allowedTools 白名单 + ScopedWorkspaceStore + 剥离 spawn 能力）
    const rawTools = buildSubagentTools({
      parentThreadId: run.parentThreadId,
      definition,
      writeScope: (run.writeScope as string[] | null) ?? null,
      runtimeType,
    });
    const tools = stripSpawnTools(rawTools as ToolSet);

    // 3. 嵌套执行（带超时）。S1（04-G11）：在子代理 scope 内执行，子代理内工具调用自动带 subagentScope 审计标记。
    const result = await Promise.race([
      runInSubagentScope({ runId, definitionId: definition.id, role: definition.role }, () =>
        modelRunner({
          modelId,
          system: SUBAGENT_SYSTEM_PROMPT,
          messages: contextPkg.messages,
          tools,
          maxSteps,
          abortSignal: options?.abortSignal,
        }),
      ),
      timeoutPromise,
    ]);

    // 4. transcript 落 artifact 文件（不进父 Message 表）
    const transcriptPath = await transcriptWriter({
      parentThreadId: run.parentThreadId,
      runId,
      data: {
        runId,
        goal: run.goal,
        contextHints: run.contextHints,
        messages: contextPkg.messages,
        output: result.text,
        finishReason: result.finishReason,
        tools: Object.keys(tools),
      },
    });
    await updateSubagentRun(runId, { transcriptPath });

    // 5. outputSchema 校验（外层手动校验，AI SDK stopWhen 不检测 schema）
    const output = tryParseOutput(result.text);
    const validation = validateOutput(
      output,
      (definition.outputSchema as Record<string, unknown> | null) ?? null,
    );
    if (!validation.ok) {
      await updateRunStatus(runId, "failed", {
        errorMessage: `outputSchema 校验失败：${validation.error}`,
      });
      return getRun(runId);
    }

    // 6. completed：resultSummary + outputArtifactId
    const resultSummary =
      typeof output === "string" ? output.slice(0, 500) : JSON.stringify(output).slice(0, 500);
    const outputArtifactId = await transcriptWriter({
      parentThreadId: run.parentThreadId,
      runId,
      data: { kind: "subagent-output", runId, output },
    });
    // outputArtifactId 用 transcript 文件路径作 ref（完整结果落 artifact）
    await updateRunStatus(runId, "completed", {
      resultSummary,
      outputArtifactId,
    });
    return getRun(runId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const current = await getRun(runId);
    if (current?.status === "cancelled") {
      return current;
    }
    if (timedOut) {
      await updateRunStatus(runId, "timed_out", {
        errorMessage: redactText(msg, run.parentThreadId),
      });
    } else if (cancelled || options?.abortSignal?.aborted) {
      await updateRunStatus(runId, "cancelled", {
        errorMessage: redactText(msg, run.parentThreadId).slice(0, 500),
      });
    } else {
      logger.warn("子代理执行失败（不崩父）", { runId, error: msg });
      await updateRunStatus(runId, "failed", { errorMessage: redactText(msg, run.parentThreadId) });
    }
    return getRun(runId);
  } finally {
    // 审计修复 M2：清除超时定时器，防止已完成 run 的孤儿定时器泄漏到事件循环
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    options?.abortSignal?.removeEventListener("abort", onAbort);
  }
}

// ─── 进程内活跃 run 跟踪（供 joinSubagent 等待）────────────────

type ActiveRunEntry = {
  promise: Promise<SubagentRun | null>;
  abortController: AbortController;
};

const activeRuns = new Map<string, ActiveRunEntry>();

/**
 * 异步启动子代理执行（不阻塞父）。spawnSubagent 调此，立即返回 runId。
 * 执行异常已在 executeSubagent 内收敛为终态；此处 catch 兜底再标 failed。
 */
export function startSubagentExecution(
  runId: string,
  options?: { timeoutMs?: number; maxSteps?: number },
): void {
  const abortController = new AbortController();
  const p = executeSubagent(runId, { ...options, abortSignal: abortController.signal })
    .catch(async (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("startSubagentExecution 兜底失败", { runId, error: msg });
      await updateRunStatus(runId, "failed", { errorMessage: msg }).catch(() => {});
      return null;
    })
    .finally(() => {
      activeRuns.delete(runId);
    });
  activeRuns.set(runId, { promise: p, abortController });
}

export function cancelSubagentExecution(runId: string): void {
  activeRuns.get(runId)?.abortController.abort("subagent_cancelled");
}

/**
 * P0 修复（G1 真并行）：批量等待多个子代理 run 完成。
 *
 * 父 agent 在单个 turn 内 spawn 多个子代理后,调本函数 `Promise.all` 并行等待,
 * 而非逐个 joinSubagent（串行）。配合 AI SDK v6 streamText 的并行工具执行,
 * 实现真正的并行子代理（一次 assistant turn 内发多个 spawn + 一次 joinSubagents）。
 *
 * 语义：
 * - 每个 runId 各自调 waitForSubagent（共享 timeoutMs 预算）
 * - 任一 run 超时/失败不影响其他 run 的等待（独立 Promise）
 * - 返回每个 run 的最终状态（completed/failed/cancelled/仍 running 等）
 * - 不修改 run 状态（waitForSubagent 内部已处理 detached 误判）
 *
 * @returns 按 runId 顺序对齐的结果数组
 */
export async function waitForSubagents(
  runIds: string[],
  timeoutMs?: number,
): Promise<Array<SubagentRun | null>> {
  if (runIds.length === 0) return [];
  // 并行等待,共享 timeoutMs 预算（从第一个 waitForSubagent 调用开始计时）
  return Promise.all(runIds.map((id) => waitForSubagent(id, timeoutMs)));
}

/**
 * 等待子代理 run 完成（joinSubagent 调此）。超时返回当前 status（不抛）。
 * run 不在本进程活跃 map 时：
 * - queued：尝试在当前进程恢复执行
 * - running：轮询 DB；超时后诚实标记 detached failure，避免无限挂起
 *
 * P0 修复（G1/G8）：超时后**不修改 run 状态**（去掉误判 failed:detached）。
 * detached run 由子代理自身 120s 超时（SUBAGENT_TIMEOUT_MS）或进程重启 orphan 清理负责终止。
 * joiner 超时只返回当前 status,让父 agent 决定是否继续等待或放弃。
 */
export async function waitForSubagent(
  runId: string,
  timeoutMs?: number,
): Promise<SubagentRun | null> {
  const wait = timeoutMs ?? 30_000;
  const local = activeRuns.get(runId);
  if (local) {
    await Promise.race([local.promise, new Promise((resolve) => setTimeout(resolve, wait))]).catch(
      () => null,
    );
    return getRun(runId);
  }

  const current = await getRun(runId);
  if (!current) return null;
  if (current.status === "queued") {
    startSubagentExecution(runId, { timeoutMs: wait });
    const restarted = activeRuns.get(runId);
    if (restarted) {
      await Promise.race([
        restarted.promise,
        new Promise((resolve) => setTimeout(resolve, wait)),
      ]).catch(() => null);
    }
    return getRun(runId);
  }
  if (current.status !== "running") {
    return current;
  }

  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const fresh = await getRun(runId);
    if (!fresh || fresh.status !== "running") return fresh;
    // S1（04-G8）：detached run 轮询间隔 500→250ms，降低 join 延迟（本地 run 走 activeRuns.promise 已无轮询）
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // P0 修复（G8）：超时只返回当前 status,不修改 run 状态。
  // 原实现 `updateRunStatus(runId, "failed", { errorMessage: "detached run" })` 会误杀
  // 正在正常执行的子代理（多实例部署/本地长跑接近 120s）。子代理自身的 120s 超时
  // 或进程重启 orphan 清理负责终止,joiner 不应单方面判定。
  return getRun(runId);
}
