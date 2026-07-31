import { buildTools } from "@/lib/ai/tools";
import { type RuntimeType, subagentQuotaConfig } from "@/lib/config";
import type { SubagentDefinition } from "@/lib/db/schema";
import { resolveRuntimes } from "@/lib/runtime/registry";
import { ScopedWorkspaceStore } from "@/lib/runtime/scoped-workspace-store";
import type { ResourceQuota, RuntimeHandle } from "@/lib/runtime/types";

/**
 * V3.5 Stage B：子代理工具/写范围收窄。
 *
 * 命门（计划执行规矩 §3 / §1 决策）：
 * - allowedTools 限制：仅 definition.allowedTools 内的工具对子代理可见，其余根本不构建。
 *   复用 buildTools 白名单过滤；SubagentToolScope 在 evaluatePermission 之上叠加——
 *   不可见工具连构建都不构建，可见工具走正常权限引擎。
 * - writeScope 收窄：写工具（writeFile/editFile/multiEditFile/applyPatch/deleteFile/git*）
 *   经 ScopedWorkspaceStore 包装的 workspace 执行，write/delete 在存储层校验路径，外则 throw。
 * - 默认只读：无 writeScope（null/空）的 definition → ScopedWorkspaceStore(writeScope=null)
 *   → write/delete 一律 throw；写工具虽可见但写入必失败。蓝图「默认只读」。
 *
 * 实现：resolveRuntimes 取父 thread 的 runtime（同 container/host），传 subagentQuotaConfig
 * 收紧 quotaOverride 构造子代理专属 execution runtime 实例（独立资源限额，04-G2 真隔离），
 * 把 workspace 包装为 ScopedWorkspaceStore 后作为 injectedRuntimes 注入 buildTools
 * （V3.5 Stage B 在 tools.ts 加的注入参数），所有工具（含 inline writeFile/readFile）自动用 scoped workspace。
 */

export type BuildSubagentToolsArgs = {
  parentThreadId: string;
  definition: SubagentDefinition;
  /** 本次实际写范围（spawn 参数合并后的）；null/空=只读。 */
  writeScope?: string[] | null;
  runtimeType?: RuntimeType;
};

/**
 * 构建子代理可见工具集（allowedTools 白名单 + ScopedWorkspaceStore 写范围收窄）。
 *
 * 返回的工具经 executeToolRun 收口（Stage C 的 executeSubagent 会传 subagentScope 审计标记）。
 */
export function buildSubagentTools(args: BuildSubagentToolsArgs) {
  // S1（04-G2 真隔离）：子代理传收紧的 quotaOverride，构造专属 execution runtime 实例
  // （resolveRuntimes 每次 new 独立实例，不复用父 runtime）。host 模式下子代理 exec 命令
  // 经 wrapWithHostRlimits(command, 子代理 quota) 施加独立 prlimit，与父进程隔离。
  // container 模式子代理复用父 container（cgroup 限额已定），受父限额 + HEAVY_COMMAND_TOOLS 互斥约束。
  const subagentQuotaOverride: Partial<ResourceQuota> = {
    pidsLimit: subagentQuotaConfig.pidsLimit,
    openFilesLimit: subagentQuotaConfig.openFilesLimit,
    timeoutMs: subagentQuotaConfig.timeoutMs,
    logCapBytes: subagentQuotaConfig.logCapBytes,
  };
  const rt = resolveRuntimes(args.parentThreadId, args.runtimeType, {
    quotaOverride: subagentQuotaOverride,
  });
  const scopedWorkspace = new ScopedWorkspaceStore(rt.workspace, args.writeScope ?? null);
  // V3.8：继承父 thread 的 capability（子代理与父共享 runtime）。
  const injected: RuntimeHandle = { ...rt, workspace: scopedWorkspace };

  const allowedTools = (args.definition.allowedTools as string[] | null) ?? [];
  return buildTools(
    args.parentThreadId,
    allowedTools,
    args.runtimeType,
    undefined, // 子代理不挂 readSkillFile（无 skillContext）
    [],
    injected,
  );
}

/** 写工具名集合：用于判定 definition 是否暴露写能力（默认只读校验用）。 */
export const WRITE_TOOL_NAMES = new Set([
  "writeFile",
  "editFile",
  "multiEditFile",
  "applyPatch",
  "deleteFile",
]);

/**
 * 判定一个 definition 是否对子代理暴露写工具（allowedTools 含任一写工具）。
 * 默认只读 lane 的 allowedTools 不含写工具 → false。
 */
export function definitionExposesWriteTools(definition: SubagentDefinition): boolean {
  const allowed = (definition.allowedTools as string[] | null) ?? [];
  return allowed.some((t) => WRITE_TOOL_NAMES.has(t));
}
