/**
 * Conformance Probe Context Builder（Contract-driven，03 专项唯一实现）。
 *
 * 事实源：
 * - docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/03-ContractDriven-ConformanceContext.md
 *
 * 职责：
 * - 读取 exact AgentContractSnapshot 的 InvocationContextContract（结构化 invocation context 子记录），
 *   按 required / preferred / accepted 语义构建 Allowed Probe Context。
 * - Conformance Runner 可提供的可信测试 Context（第一版固定能力）：
 *   execution_subject（platform_service = signer.runnerIdentity）、current_datetime（每次刷新）、
 *   timezone（UTC，测试 Runner 自身时区）、locale（supportedLocales[0]，Provider 自己声明支持）。
 * - 其余 context kind（conversation/workspace/organization/memory/knowledge/attachment 等）
 *   一律 not_available —— Conformance 不伪造业务数据。
 *
 * 关键约束：
 * - 未声明的 Context 绝不能发送（严格 Provider 对未知 key fail closed 时应能注册成功）。
 * - required 无法提供 → 网络前 fail（ConformanceProbeContextUnavailableError，
 *   稳定 Registration error reason = conformance_context_unavailable）。
 * - accepted 不主动选择（Agent 可以消费 ≠ Harness 主动发）。
 * - 每条 Probe Message 刷新 current_datetime（metadataFactory 每次调用重建）。
 * - 复用唯一公共 metadata mapper（buildA2APublicMessageMetadata）的键约定，
 *   不引入第二 Context Authority。
 */
import { db } from "@/lib/db/client";
import { agentContractInvocationContextTable } from "@/lib/persistence/schema/agents";
import {
  executionSubjectFromServiceIdentity,
  executionSubjectToPublicAgentSubject,
} from "@/lib/runtime/transport/execution-subject";
import { asc, eq } from "drizzle-orm";

/** required 无法提供时的稳定失败（网络前 fail closed）。 */
export class ConformanceProbeContextUnavailableError extends Error {
  constructor(readonly contextKind: string) {
    super(`Conformance 无法提供 required context：${contextKind}`);
    this.name = "ConformanceProbeContextUnavailableError";
  }
}

/** builder 入参。 */
export interface BuildExternalConformanceProbeContextInput {
  tenantId: string;
  /** exact AgentContractSnapshot id。 */
  snapshotId: string;
  /** 快照声明支持的 locale（空数组 = 合同本身非法，登记侧应已拒绝）。 */
  supportedLocales: readonly string[];
  /** 平台 Conformance signer runnerIdentity（probe 的 platform_service subject 来源）。 */
  runnerIdentity: string;
  /** 可注入时钟。 */
  now?: () => Date;
}

/** builder 结果。 */
export interface ExternalConformanceProbeContext {
  /** 每条 Probe Message 调用一次；current_datetime 每次刷新。 */
  metadataFactory: () => Record<string, unknown>;
  /** 审计摘要（只记录 kind，不记录 value）。 */
  probeContextKinds: {
    supplied: string[];
    omittedPreferred: string[];
    /** 成功时恒空。 */
    unavailableRequired: string[];
  };
}

/** Conformance Runner 第一版可提供的 context kind。 */
const SUPPORTED_PROBE_CONTEXT_KINDS = new Set([
  "execution_subject",
  "current_datetime",
  "timezone",
  "locale",
]);

/**
 * 按 exact Snapshot 的 InvocationContextContract 构建 Conformance Probe Context。
 *
 * @throws ConformanceProbeContextUnavailableError required context 无法提供（网络前 fail）
 */
export async function buildExternalConformanceProbeContext(
  input: BuildExternalConformanceProbeContextInput,
): Promise<ExternalConformanceProbeContext> {
  const now = input.now ?? (() => new Date());

  // 读取结构化 invocation context 子记录（position 升序；租户限定）。
  const rows = await db
    .select({
      key: agentContractInvocationContextTable.key,
      necessity: agentContractInvocationContextTable.necessity,
    })
    .from(agentContractInvocationContextTable)
    .where(eq(agentContractInvocationContextTable.snapshotId, input.snapshotId))
    .orderBy(asc(agentContractInvocationContextTable.position));

  const supplied: string[] = [];
  const omittedPreferred: string[] = [];
  const unavailableRequired: string[] = [];

  for (const row of rows) {
    const kind = row.key;
    if (row.necessity === "accepted") {
      // accepted：Conformance 默认不主动选择（03 §四）。
      continue;
    }
    if (SUPPORTED_PROBE_CONTEXT_KINDS.has(kind)) {
      supplied.push(kind);
      continue;
    }
    if (row.necessity === "required") {
      unavailableRequired.push(kind);
    } else {
      omittedPreferred.push(kind);
    }
  }

  if (unavailableRequired.length > 0) {
    // required 无法提供 → 网络前 fail closed（03 §四）。
    throw new ConformanceProbeContextUnavailableError(unavailableRequired[0] as string);
  }

  /** 按合同声明的 kind 现取 value（current_datetime 每次调用刷新）。 */
  const valueOf = (kind: string): unknown => {
    switch (kind) {
      case "execution_subject":
        return executionSubjectToPublicAgentSubject(
          executionSubjectFromServiceIdentity(input.tenantId, input.runnerIdentity),
        );
      case "current_datetime":
        return now().toISOString();
      case "timezone":
        return "UTC";
      case "locale":
        return input.supportedLocales[0] ?? null;
      default:
        return null;
    }
  };

  const metadataFactory = (): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {};
    for (const kind of supplied) {
      metadata[kind] = valueOf(kind);
    }
    return metadata;
  };

  return {
    metadataFactory,
    probeContextKinds: {
      supplied,
      omittedPreferred,
      unavailableRequired,
    },
  };
}
