import { AsyncLocalStorage } from "node:async_hooks";
import { getToolMetadata } from "@/lib/ai/tool-registry";
import { recordAuditFailure } from "@/lib/audit/retry-queue";
import { toolTimeoutConfig } from "@/lib/config";
import {
  appendThreadEvent,
  consumeOnceApproval,
  createToolRun,
  findMatchingApprovals,
  finishToolRunFailure,
  finishToolRunSuccess,
  getThreadById,
  listPermissionRules,
  requestApprovalAtomic,
  updateThreadStatus,
} from "@/lib/db/queries";
import type { ToolApprovalRequest } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { computeArgFingerprint, summarizeArgs } from "@/lib/permission/approval";
import {
  type PermissionRule,
  type PermissionVerdict,
  evaluatePermission,
} from "@/lib/permission/engine";
import { toPermissionRule } from "@/lib/permission/rules";
import { runFormatOnWrite } from "@/lib/policy/hooks";
import { redactObject } from "@/lib/runtime/secret-redaction";
import { recordAdminAudit } from "@/lib/studio/admin-audit";

/**
 * P1 修复（01 AI Core P1-5）：工具执行并发信号量。
 *
 * 原实现完全依赖 AI SDK v6 默认并行,模型一轮 emit 多个重工具(runCommand/runBuild/
 * installDependencies/webFetch)时无并发上限,可耗尽 CPU/内存/出网连接。
 * 按 meta.risk 分类限流:execute(进程类)与 network(出网类)受限,read/write/delivery
 * 不限(本地、快、无资源争用)。read/write 不限流避免拖慢正常文件操作。
 *
 * 信号量进程级(单实例部署语义);多实例下由各自进程分担,近似限流。
 */
const TOOL_CONCURRENCY: Partial<Record<string, number>> = {
  // execute 类:runCommand/runBuild/installDependencies 等 spawn 进程,上限保守
  execute: Number.parseInt(process.env.SNOW_TOOL_CONCURRENCY_EXECUTE ?? "2", 10) || 2,
  // network 类:webFetch 等出网,上限略宽
  network: Number.parseInt(process.env.SNOW_TOOL_CONCURRENCY_NETWORK ?? "4", 10) || 4,
};

/**
 * P0 修复（04 Subagent G2）：重命令工具进程级互斥(短期方案)。
 *
 * 子代理(verifier lane)复用父 runtime,其 runTests/runCommand 与父 agent 的同类工具
 * 并发会抢 CPU/端口/构建产物。risk 信号量(execute 并发 2)仍允许"父 1 + 子 1"并发。
 * 对重命令工具额外加全局互斥(并发 1),父子串行执行,防资源争用。
 *
 * 仅限前台重命令工具(runCommand/runTests/runBuild/installDependencies);
 * startBackground 虽是 command 类但启动即返回,不在此列。长期方案为 executor lane
 * 分配独立 container(见 04-subagent.md G2),本互斥为过渡期短期方案。
 */
export const HEAVY_COMMAND_TOOLS = new Set([
  "runCommand",
  "runTests",
  "runBuild",
  "installDependencies",
]);

/**
 * S1（07-P2-4）：高危工具白名单。
 *
 * 这些工具的执行会带来不可逆 / 高影响后果（执行任意命令、装包可跑 postinstall、删文件、
 * 部署到环境、推 git、创建 PR、回滚部署），需要专项审计：完整 input 落 AdminAuditLog
 * （secret/token/password 字段经 sanitizeAuditMetadata 脱敏）。
 *
 * 判定标准：execute/delivery risk 且能产生不可逆外部影响。read/network 类不在此列
 * （read 无副作用；webFetch 已走域名治理审计）。deleteFile / applyPatch 走 ask 审批
 * 流程已记录 input，但执行成功后再补一条 audit 行，确保审批 + 执行双重可追溯。
 */
export const HIGH_RISK_TOOLS = new Set([
  "runCommand",
  "runTests",
  "runBuild",
  "installDependencies",
  "deleteFile",
  "applyPatch",
  "multiEditFile",
  "gitCommit",
  "gitCheckpoint",
  "gitPush",
  "gitCreateBranch",
  "gitRestoreCheckpoint",
  "createPullRequest",
  "deployToEnvironment",
  "rollback",
  "callMcpTool",
  "startBackgroundTask",
]);

/** 简易计数信号量:acquire 返回 release 函数,超限时排队等待。 */
export class CountingSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
  /** 当前活跃名额数(供测试观测)。 */
  get activeCount(): number {
    return this.active;
  }
}

// V6-M3-1（B4）：重命令工具 per-thread 互斥（替代原全局单例）。
// subagent 共享 parentThreadId（executeToolRun 传入的即 parentThreadId），
// 因此父子 thread 天然串行；不同顶层 thread 互不阻塞。
const heavyMutexMap = new Map<string, CountingSemaphore>();
function getHeavyMutex(threadId: string): CountingSemaphore {
  let sem = heavyMutexMap.get(threadId);
  if (!sem) {
    sem = new CountingSemaphore(1);
    heavyMutexMap.set(threadId, sem);
  }
  return sem;
}

const semaphores = new Map<string, CountingSemaphore>();
function getSemaphore(risk: string): CountingSemaphore | null {
  const max = TOOL_CONCURRENCY[risk];
  if (max === undefined) return null; // read/write/delivery 不限流
  let sem = semaphores.get(risk);
  if (!sem) {
    sem = new CountingSemaphore(max);
    semaphores.set(risk, sem);
  }
  return sem;
}

/**
 * Phase 2 Stage B：工具执行统一收口入口（蓝图 §7.2 / 方案 §8.2）。
 *
 * 所有工具调用经此包裹，复用同一套 tool_runs 落库与事件追加，不另起日志体系。
 * 事件名取自 §6.1.1 权威表的三态模型（tool.called / tool.succeeded / tool.failed）。
 *
 * 失败语义（三类都落 tool_runs.failed + tool.failed，用 payload.failureKind 区分）：
 * - crash：runner 抛异常（工具代码本身崩溃）→ failureKind = "crash"，异常重新抛出
 * - business：runner 正常返回但约定 { ok: false }（命令报错 / 测试红 / 探活失败 / 文件不存在）
 *     → failureKind = "business"，结果原样透传给上层（不改 agent 契约、不 throw）
 * - policy（V3.1）：evaluatePermission 判定 deny → failureKind = "policy"，
 *     不跑 runner，直接返回 { ok: false, error }（fail-closed，治理目的）。
 *
 * V3.1：deny-only 的 beforeTool 升级为 allow/deny/ask 三态 evaluatePermission。
 * - allow（含 ask 升级）→ 跑 runner
 * - deny → fail-closed（与原 beforeTool deny 零回归）
 * - ask 且无既定批准 → fail-fast 暂停（不长轮询）：tool_runs.status=awaiting_approval，
 *   创建 ToolApprovalRequest，append tool.approval_requested + agent.status_changed，
 *   thread 转 awaiting_approval，返回 { ok:false, awaitingApproval:true } 结束当前 step。
 *   用户审批后前端重发 chat，模型重试工具，引擎查到已批准 → allow。
 *   理由：app/api/chat/route.ts maxDuration=60 无法支撑人工审批阻塞。
 */

/** 工具统一约定：返回 { ok: false } 表示业务失败。 */
function isBusinessFailure(output: unknown): output is { ok: false } {
  return (
    typeof output === "object" &&
    output !== null &&
    "ok" in output &&
    (output as { ok?: unknown }).ok === false
  );
}

/** 从业务失败结果里提取可读错误文本。 */
function extractError(output: unknown): string {
  const o = output as { error?: unknown; stderr?: unknown };
  if (typeof o.error === "string" && o.error.length > 0) return o.error;
  if (typeof o.stderr === "string" && o.stderr.length > 0) return o.stderr;
  return "工具返回 ok:false";
}

/** tool.called 事件附带的 registry metadata（V3.0 Stage B）。 */
function calledMeta(
  meta: ReturnType<typeof getToolMetadata>,
  subagentScope?: { runId: string; definitionId: string; role: string },
): Record<string, unknown> {
  const base = meta
    ? { category: meta.category, risk: meta.risk, permissionKey: meta.permissionKey }
    : {};
  return subagentScope ? { ...base, subagent: subagentScope } : base;
}

/**
 * S1 修复（01-P2-7）：统一解析工具超时（ms）。
 *
 * 取 min(callerOverride, meta.defaultTimeoutMs, meta.maxTimeoutMs, toolTimeoutConfig.maxMs)。
 * callerOverride 缺省用 meta.defaultTimeoutMs ?? toolTimeoutConfig.defaultMs。
 * 各 execute 工具不再各自硬编码超时，统一经此收口，运维可 env 覆盖全局默认/上限。
 */
export function resolveToolTimeoutMs(toolName: string, callerOverride?: number): number {
  const meta = getToolMetadata(toolName);
  const def = meta?.defaultTimeoutMs ?? toolTimeoutConfig.defaultMs;
  // 全局 max（env）是硬上限，per-tool maxTimeoutMs 不得超过它；取两者 min。
  const max = Math.min(meta?.maxTimeoutMs ?? toolTimeoutConfig.maxMs, toolTimeoutConfig.maxMs);
  const effective = callerOverride ?? def;
  return Math.min(effective, max);
}

/**
 * S1 修复（04-G11）：子代理工具调用审计标记。
 *
 * 子代理执行经 AsyncLocalStorage 注入 { runId, definitionId, role }，子代理内工具的 executeToolRun
 * 自动读取（无需每个工具显式传 subagentScope），写入 tool.called 事件 payload 供审计/归属。
 * 主链路（无子代理）getStore()=undefined，零回归。
 */
type SubagentScope = { runId: string; definitionId: string; role: string };
export const subagentScopeStorage = new AsyncLocalStorage<SubagentScope>();
const toolApprovalStorage = new AsyncLocalStorage<string | null>();

export function getCurrentToolApprovalId(): string | null {
  return toolApprovalStorage.getStore() ?? null;
}

/** 在子代理 scope 内执行 fn（fn 内的 executeToolRun 自动带上 subagentScope 审计标记）。 */
export function runInSubagentScope<T>(scope: SubagentScope, fn: () => Promise<T>): Promise<T> {
  return subagentScopeStorage.run(scope, fn);
}

/**
 * V6-M2-2: 工具级硬超时错误（G1/B1）。
 * Promise.race 包裹 runner，超时后抛出此错误，由 executeToolRun catch 转为 failureKind="timeout"。
 */
export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTimeoutError";
  }
}

/**
 * S1（07-P1-1）：per-thread projectId 注入（供 project-scope 权限规则匹配）。
 * thread-runner 在 run 开始时 setThreadProjectScope，结束时 clear；executeToolRun 读取为 projectId fallback。
 * 用 Map 而非 ALS，避免 streamText 异步上下文包装的复杂性（per-thread key 隔离，请求级生命周期）。
 */
const projectScopeByThread = new Map<string, string>();

/** 设置 thread 的 projectId（thread-runner run 开始时调）。 */
export function setThreadProjectScope(threadId: string, projectId: string): void {
  projectScopeByThread.set(threadId, projectId);
}

/** 清除 thread 的 projectId（thread-runner run 结束时调）。 */
export function clearThreadProjectScope(threadId: string): void {
  projectScopeByThread.delete(threadId);
}

/**
 * S1（07-P1-1）：per-thread skillId 注入（供 skill-scope 权限规则匹配）。
 * V8 阶段 8：thread-runner 不再从 thread.activeSkillId 注入（Skill 不再绑定 thread）。
 * setThreadSkillScope 仍保留供未来 run 级 scope 注入；当前 chat 路径不调用。
 * executeToolRun 读取 skillId fallback 为 null（skill-scope 规则 scopeRef=null 放行）。
 */
const skillScopeByThread = new Map<string, string>();

/** 设置 thread 的 skillId（thread-runner run 开始时调）。 */
export function setThreadSkillScope(threadId: string, skillId: string): void {
  skillScopeByThread.set(threadId, skillId);
}

/** 清除 thread 的 skillId（thread-runner run 结束时调）。 */
export function clearThreadSkillScope(threadId: string): void {
  skillScopeByThread.delete(threadId);
}

/**
 * V7 S2-2：per-thread runId 注入（ToolRun 归属 ThreadRun）。
 * thread-runner 在 run 开始时 setThreadRunScope，结束时 clear；
 * executeToolRun 读取并传给 createToolRun / requestApprovalAtomic。
 */
const runScopeByThread = new Map<string, string>();

/** 设置 thread 的当前 ThreadRun id（thread-runner run 开始时调）。 */
export function setThreadRunScope(threadId: string, runId: string): void {
  runScopeByThread.set(threadId, runId);
}

/** 清除 thread 的当前 ThreadRun id（thread-runner run 结束时调）。 */
export function clearThreadRunScope(threadId: string): void {
  runScopeByThread.delete(threadId);
}

/**
 * 读取 thread 的当前 ThreadRun id（供浏览器工具等模块获取真实 runId）。
 * 返回 null 表示当前不在 run 上下文中（如用户直接调 API）。
 */
export function getThreadRunScope(threadId: string): string | null {
  return runScopeByThread.get(threadId) ?? null;
}

export async function executeToolRun<T>(
  threadId: string,
  toolName: string,
  input: Record<string, unknown>,
  runner: (signal?: AbortSignal) => Promise<T>,
  options?: {
    /**
     * V3.4：覆盖 permissionKey（默认 meta?.permissionKey ?? `tool.${toolName}`）。
     * MCP `mcp.<server>.<tool>` / web `web.fetch` 等动态/非 tool. 前缀 key 用。
     */
    permissionKey?: string;
    /**
     * V3.4：覆盖权限评估函数（默认 evaluatePermission，按规则匹配）。
     * web 工具用域名治理（allowlist/blacklist）替代规则匹配产出 allow/ask/deny，
     * 复用本函数的 ask 暂停 / deny fail-closed / allow 跑 runner 机器，避免重复实现。
     * 返回的 verdict 经本函数既有分支处理（ask 升级既定批准、deny fail-closed 等）。
     */
    evaluate?: (args: {
      input: Record<string, unknown>;
      threadId: string;
      permissionKey: string;
      dbRules: PermissionRule[];
      existingApprovals: ToolApprovalRequest[];
    }) => PermissionVerdict;
    /**
     * V3.5：子代理工具审计标记。子代理执行的工具调用经此传入 { runId, definitionId, role }，
     * 写入 tool.called 事件 payload 供审计/归属（transcript 落 artifact，不进 Message 表）。
     * 缺省 → undefined，主链路行为零回归（事件 payload 不含 subagent 字段）。
     */
    subagentScope?: { runId: string; definitionId: string; role: string };
    /**
     * S1（07-P1-1）：当前 thread 的 projectId，传给 evaluatePermission 供 project-scope 规则匹配。
     * 缺省 → undefined（project scope 规则按 thread 收敛，零回归）。
     */
    projectId?: string | null;
    /**
     * S1（07-P1-1）：当前 thread 绑定的 skillId，传给 evaluatePermission 供 skill-scope 规则匹配。
     * 缺省 → undefined（读 skillScopeByThread，无绑定 skill 时 null）。
     */
    skillId?: string | null;
    /**
     * V6-Batch1-M1：AbortSignal 注入，让工具执行响应取消。
     * 缺省 → undefined（runner 不响应取消，向后兼容）。
     */
    abortSignal?: AbortSignal;
  },
): Promise<T> {
  const meta = getToolMetadata(toolName);
  const permissionKey = options?.permissionKey ?? meta?.permissionKey ?? `tool.${toolName}`;
  const argFingerprint = computeArgFingerprint(permissionKey, input);
  // V3.5：子代理审计标记。S1（04-G11）：显式传入优先，否则读 AsyncLocalStorage（子代理执行自动注入）。
  const subagentScope = options?.subagentScope ?? subagentScopeStorage.getStore();
  // V7 S2-3：当前 ThreadRun id，传给 appendThreadEvent 做事件归属。
  const currentRunId = runScopeByThread.get(threadId) ?? null;

  // 评估权限：加载 DB 规则 + 既有批准（ask→allow 升级用）。默认规则由 buildDefaultRules
  // 从 PolicyConfig 派生（deny 零回归），无需 DB。
  const [dbRules, existingApprovals] = await Promise.all([
    listPermissionRules().then((rows) => rows.map(toPermissionRule)),
    // V6-M3-5（C4）：传 projectId 供 project scope 跨 thread 匹配
    findMatchingApprovals({
      permissionKey,
      argFingerprint,
      threadId,
      projectId: options?.projectId ?? projectScopeByThread.get(threadId) ?? null,
    }),
  ]);
  const verdict = options?.evaluate
    ? options.evaluate({ input, threadId, permissionKey, dbRules, existingApprovals })
    : evaluatePermission({
        toolName,
        input,
        threadId,
        projectId: options?.projectId ?? projectScopeByThread.get(threadId) ?? null,
        skillId: options?.skillId ?? skillScopeByThread.get(threadId) ?? null,
        permissionKey,
        dbRules,
        existingApprovals,
      });

  // deny：fail-closed，不跑 runner（与原 beforeTool deny 零回归）
  // 审计修复 H1：deny 路径 input 也需脱敏后再落库（原代码明文写入 tool_runs + thread_events，
  // 若模型构造含 secret 的 input 则泄漏到 DB / SSE / 审计面板）。与 allow 路径对齐。
  if (verdict.decision === "deny") {
    const safeInput = redactObject(input, threadId);
    const run = await createToolRun({
      threadId,
      toolName,
      input: safeInput,
      runId: runScopeByThread.get(threadId) ?? null,
    });
    await appendThreadEvent(
      threadId,
      "tool.called",
      {
        toolRunId: run.id,
        toolName,
        input: safeInput,
        ...calledMeta(meta, subagentScope),
      },
      currentRunId,
    );
    const reason = verdict.reason ?? "policy 拦截";
    const error = `policy 拦截：${reason}`;
    await finishToolRunFailure(run.id, error);
    await appendThreadEvent(
      threadId,
      "tool.failed",
      {
        toolRunId: run.id,
        error,
        failureKind: "policy",
        reason,
      },
      currentRunId,
    );
    return { ok: false, error } as unknown as T;
  }

  // ask 且无既定批准：fail-fast 暂停，结束当前 step（不跑 runner）
  if (verdict.decision === "ask") {
    // S1（08-P1-6）：createToolRun + createApprovalRequest + updateThreadStatus 单事务原子化，
    // 消除原分散调用的部分成功风险（approval 已建但 thread 未更新则卡 executing）。
    // 事件追加在事务外（append-only best-effort）。
    // 审计修复 H1：ask 路径 input 也需脱敏后再落库（原代码明文写入 tool_runs、approval_requests、
    // thread_events；summarizeArgs 对非路径/命令工具序列化完整 input 含 secret）。与 allow 路径对齐。
    const safeInput = redactObject(input, threadId);
    const argSummary = summarizeArgs(toolName, safeInput);
    const { run, approval } = await requestApprovalAtomic({
      threadId,
      toolName,
      input: safeInput,
      permissionKey,
      argFingerprint,
      argSummary,
      // V6-M3-5（C4）：记录 projectId 供 project scope 跨 thread 审批复用
      projectId: options?.projectId ?? projectScopeByThread.get(threadId) ?? null,
      // V7 S2-2：归属 ThreadRun
      runId: runScopeByThread.get(threadId) ?? null,
    });
    await appendThreadEvent(
      threadId,
      "tool.called",
      {
        toolRunId: run.id,
        toolName,
        input: safeInput,
        ...calledMeta(meta, subagentScope),
      },
      currentRunId,
    );
    await appendThreadEvent(
      threadId,
      "tool.approval_requested",
      {
        approvalId: approval.id,
        toolRunId: run.id,
        toolName,
        permissionKey,
        argSummary,
      },
      currentRunId,
    );
    await appendThreadEvent(
      threadId,
      "agent.status_changed",
      {
        from: "executing",
        to: "awaiting_approval",
        reason: "tool_approval_required",
      },
      currentRunId,
    );
    return {
      ok: false,
      awaitingApproval: true,
      pendingApprovalId: approval.id,
      approvalId: approval.id,
    } as unknown as T;
  }

  // allow（含 ask 升级）：跑 runner
  // 审计修复：对 input 做 secret 脱敏后再落库/广播（原 input 明文写入 tool_runs、
  // thread_events、SSE，若模型构造含 secret 的 input 则泄漏）。output 已有脱敏（下方）。
  const safeInput = redactObject(input, threadId);
  const run = await createToolRun({
    threadId,
    toolName,
    input: safeInput,
    runId: runScopeByThread.get(threadId) ?? null,
  });
  await appendThreadEvent(
    threadId,
    "tool.called",
    {
      toolRunId: run.id,
      toolName,
      input: safeInput,
      ...calledMeta(meta, subagentScope),
      ...(verdict.existingApprovalId ? { approvedBy: verdict.existingApprovalId } : {}),
    },
    currentRunId,
  );
  if (verdict.existingApprovalId && verdict.existingApprovalScope === "once") {
    const consumed = await consumeOnceApproval(verdict.existingApprovalId);
    if (!consumed) {
      const error = "一次性审批已被使用或失效，请重新申请审批";
      await finishToolRunFailure(run.id, error);
      await appendThreadEvent(
        threadId,
        "tool.failed",
        {
          toolRunId: run.id,
          error,
          failureKind: "policy",
          reason: "once_approval_consumed",
        },
        currentRunId,
      );
      return { ok: false, error } as unknown as T;
    }
  }

  let output: T;
  // P1 修复（01 AI Core P1-5）：按 risk 限流(execute/network),防重工具并发耗尽资源。
  // read/write/delivery 不限流(getSemaphore 返回 null)。限流在 permission 通过后,
  // 不影响 deny/ask 的 fail-closed/fail-fast 语义。
  const semaphore = getSemaphore(meta?.risk ?? "");
  const release = semaphore ? await semaphore.acquire() : null;
  // V6-M3-1（B4）：重命令工具 per-thread 互斥（subagent 共享 parentThreadId，父子天然串行）
  const releaseHeavy = HEAVY_COMMAND_TOOLS.has(toolName)
    ? await getHeavyMutex(threadId).acquire()
    : null;
  try {
    // V6-M2-2: 工具级硬超时包裹（G1/B1）—— Promise.race 兜底，防 runner 无限挂起
    const timeoutMs = resolveToolTimeoutMs(toolName);
    output = await Promise.race([
      toolApprovalStorage.run(verdict.existingApprovalId ?? null, () =>
        runner(options?.abortSignal),
      ),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new ToolTimeoutError(`Tool "${toolName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // abortSignal 触发时清除 timer（避免泄漏）
        options?.abortSignal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        // runner 正常完成时也清除 timer
        // (Promise.race 结束后 timer 仍 pending，由 clearTimeout 在此回调内处理)
      }),
    ]);
  } catch (error) {
    // V6-M2-2: 工具级硬超时（G1/B1）—— ToolTimeoutError 隔离为 timeout failureKind
    if (error instanceof ToolTimeoutError) {
      const errorText = error.message;
      await finishToolRunFailure(run.id, errorText);
      await appendThreadEvent(
        threadId,
        "tool.failed",
        {
          toolRunId: run.id,
          error: errorText,
          failureKind: "timeout",
        },
        currentRunId,
      );
      return { ok: false, error: errorText, failureKind: "timeout" } as unknown as T;
    }
    // crash：工具代码本身崩溃
    // V3.8：错误信息脱敏（防止 secret 明文进入 tool_runs / 事件）
    const rawError = error instanceof Error ? error.message : String(error);
    const errorText = redactObject(rawError, threadId);
    await finishToolRunFailure(run.id, errorText);
    await appendThreadEvent(
      threadId,
      "tool.failed",
      {
        toolRunId: run.id,
        error: errorText,
        failureKind: "crash",
      },
      currentRunId,
    );
    // P1 修复(01 AI Core P1-4): crash 收敛为结构化结果返回给模型,不中断主循环。
    // 原实现 throw error 重新抛出,可能导致整个 streamText 流终止,agent 无法继续。
    // Claude Code 的工具错误被隔离为工具结果,主循环不受影响。现在收敛为
    // { ok:false, error, failureKind:"crash" } 让 agent 决定重试或换方案。
    // 仅在不可恢复的协议错误(AbortError)时才向上抛(由调用方判断)。
    if (error instanceof Error && error.name === "AbortError") {
      throw error; // 中断信号向上传播,让 streamText 正常终止
    }
    return { ok: false, error: errorText, failureKind: "crash" } as unknown as T;
  } finally {
    // P1-5/04-G2:反序释放(先 heavy 互斥再 risk 信号量),无论成功/失败/中断
    releaseHeavy?.();
    release?.();
  }

  // V3.8：输出脱敏（secret 明文不进 tool_runs / 事件 / 上下文）
  output = redactObject(output, threadId);

  if (isBusinessFailure(output)) {
    // business：runner 正常返回 { ok: false }，记为失败但原样透传给上层（不破坏 agent 契约）
    const errorText = extractError(output);
    await finishToolRunFailure(run.id, errorText);
    await appendThreadEvent(
      threadId,
      "tool.failed",
      {
        toolRunId: run.id,
        error: errorText,
        failureKind: "business",
      },
      currentRunId,
    );
    return output;
  }

  // afterTool：写后自动格式化（best-effort，fail-open，不阻断成功返回）
  // P1-10: 工具已成功执行(副作用不可逆),后续落库/格式化失败不应让 run 崩溃;
  // 注释承诺 fail-open,实现补齐 try/catch + 日志。
  if (toolName === "writeFile" && typeof input.path === "string") {
    try {
      await runFormatOnWrite(threadId, input.path);
    } catch (err) {
      logger.warn("[tool-runtime] runFormatOnWrite 失败(fail-open)", {
        threadId,
        path: input.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await finishToolRunSuccess(run.id, output as Record<string, unknown>);
  } catch (err) {
    logger.warn("[tool-runtime] finishToolRunSuccess 失败(fail-open)", {
      threadId,
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await appendThreadEvent(
      threadId,
      "tool.succeeded",
      {
        toolRunId: run.id,
        output,
      },
      currentRunId,
    );
  } catch (err) {
    logger.warn("[tool-runtime] appendThreadEvent(tool.succeeded) 失败(fail-open)", {
      threadId,
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // S1（07-P2-4）：高危工具执行成功后落专项审计（完整 input 经脱敏）。
  // fail-open：审计写入失败不阻塞工具结果（已成功执行不可逆），仅日志告警。
  // actorUserId 取 thread.userId（执行者）。仅高危工具查一次 thread，避免常态开销。
  if (HIGH_RISK_TOOLS.has(toolName)) {
    // P1-11: auditUserId 提到 try 外,catch 内重放 payload 需引用
    let auditUserId = "unknown";
    try {
      const threadRow = await Promise.resolve(getThreadById(threadId)).catch(() => null);
      // M1-3: 审计 actorUserId 回退改 "unknown"（G3）— 避免 threadId 污染审计日志
      auditUserId = threadRow?.userId ?? "unknown";
      await recordAdminAudit({
        actorUserId: auditUserId,
        action: "tool.high_risk.executed",
        targetType: "tool_run",
        targetId: run.id,
        outcome: "succeeded",
        metadata: {
          toolName,
          threadId,
          toolRunId: run.id,
          permissionKey,
          argFingerprint,
          input: safeInput,
          ...(subagentScope ? { subagent: subagentScope } : {}),
        },
      });
    } catch (err) {
      // M1-3 + P1-11: 审计 fail-closed — 写入失败进重试队列,payload 存完整审计入参供 sweep 重放。
      await recordAuditFailure({
        threadId,
        toolName,
        runId: run.id,
        error: String(err),
        payload: {
          auditInput: {
            actorUserId: auditUserId,
            action: "tool.high_risk.executed",
            targetType: "tool_run",
            targetId: run.id,
            outcome: "succeeded",
            metadata: {
              toolName,
              threadId,
              toolRunId: run.id,
              permissionKey,
              argFingerprint,
              input: safeInput,
              ...(subagentScope ? { subagent: subagentScope } : {}),
            },
          },
        },
        timestamp: new Date(),
      });
    }
  }

  return output;
}
