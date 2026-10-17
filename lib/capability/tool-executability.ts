import { providerExecutorKind } from "@/lib/capability/provider-executor-kind";
/**
 * Tool 可执行性判定（单一事实源）。
 *
 * 背景：Tool 的"是否可执行"判定原本散在三处各自实现——
 *   1. `build-production-capability-catalog`（装载进能力目录）；
 *   2. `apply-tool-call`（发起调用时校验）；
 *   3. `tool-execution-worker`（执行前校验）。
 * 三处检查项已不一致（如 executionTarget 仅在 catalog 解析），新增执行器
 * （如 mcp）时极易漏改。本模块统一为唯一判定入口，三处共用。
 *
 * 判定顺序（任一不过即不可执行，附 reasonCode 供 unavailableFacts / 错误映射）：
 *   1. revision 存在且 published；
 *   2. provider 存在且 enabled；
 *   3. 由 providerType + executionContract.providerOperationMetadata 派生 executorKind，
 *      且 registry 支持该 (providerType, executorKind)；
 *   4. webhook 必须挂 enabled 且带 endpointRef 的 connection；
 *   5. connection.authMethod ∈ {none, bearer}（无 connection 视为 none）；
 *   6. contract digest 与实际 revision 冻结的 digest 一致（防篡改）。
 *
 * 不包含的部分（调用方各自负责）：
 * - 执行目标解析（executionTarget，仅 catalog 需要 thread/workspace 事实）；
 * - schemaHash 比对、arguments 校验（apply-tool-call 独有）；
 * - tool/Provider/connection 之外的加载（caller 自行查询后传入 facts）。
 */
import type { ToolExecutionContract } from "@/lib/capability/tool-execution-contract";
import { computeToolExecutionContractDigest } from "@/lib/capability/tool-execution-contract";

/** 判定所需的已加载事实（caller 查库后传入；本模块不发 DB）。 */
export interface ToolExecutabilityFacts {
  tool: { id: string; lifecycleState: string };
  provider: {
    id: string;
    providerType: string;
    lifecycleState: string;
    connectionId: string | null;
  };
  revision: {
    id: string;
    revisionState: string;
    executionContractDigest: string;
    contract: ToolExecutionContract;
  };
  connection: {
    id: string;
    lifecycleState: string;
    endpointRef: string | null;
    authMethod: string;
  } | null;
}

export interface ToolExecutabilityResult {
  executable: boolean;
  /** executorKind（仅 executable=true 时有值）。 */
  executorKind?: string;
  /** 不可执行原因码（用于 unavailableFacts / 错误映射）。 */
  reasonCode?: string;
  /** 人类可读原因（可选）。 */
  detail?: string;
}

/** 支持判定所需的 provider executor registry 视图（只依赖 supports，避免绑定实现）。 */
export interface ExecutorSupport {
  supports(providerType: string, executorKind: string): boolean;
}

/**
 * 判定一个 Tool 是否可执行。
 *
 * @param facts 已加载的 tool / provider / revision / connection 事实
 * @param registry 执行器注册表（提供 supports）
 */
export function resolveToolExecutability(
  facts: ToolExecutabilityFacts,
  registry: ExecutorSupport,
): ToolExecutabilityResult {
  // 1. revision 必须存在且已发布
  if (facts.revision.revisionState !== "published") {
    return {
      executable: false,
      reasonCode: "schema_revision_not_published",
      detail: `revisionState=${facts.revision.revisionState}`,
    };
  }
  // 2. tool / provider 必须 enabled
  if (facts.tool.lifecycleState !== "enabled") {
    return {
      executable: false,
      reasonCode: "tool_not_enabled",
      detail: `tool.lifecycleState=${facts.tool.lifecycleState}`,
    };
  }
  if (facts.provider.lifecycleState !== "enabled") {
    return {
      executable: false,
      reasonCode: "provider_not_enabled",
      detail: `provider.lifecycleState=${facts.provider.lifecycleState}`,
    };
  }
  // 3. executorKind 派生 + registry 支持
  const executorKind = providerExecutorKind(
    facts.provider.providerType,
    facts.revision.contract.providerOperationMetadata,
  );
  if (!executorKind) {
    return {
      executable: false,
      reasonCode: "provider_executor_kind_unknown",
      detail: `providerType=${facts.provider.providerType}`,
    };
  }
  if (!registry.supports(facts.provider.providerType, executorKind)) {
    return {
      executable: false,
      reasonCode: "provider_executor_unavailable",
      detail: `${facts.provider.providerType}/${executorKind}`,
    };
  }
  // 4. webhook 必须可用的 connection
  if (facts.provider.providerType === "webhook") {
    if (
      !facts.connection ||
      facts.connection.lifecycleState !== "enabled" ||
      !facts.connection.endpointRef
    ) {
      return {
        executable: false,
        reasonCode: "provider_connection_unavailable",
        detail: "webhook 需要 enabled 且带 endpointRef 的 connection",
      };
    }
  }
  // 5. connection authMethod 必须可解析
  if (facts.connection && !["none", "bearer"].includes(facts.connection.authMethod)) {
    return {
      executable: false,
      reasonCode: "unsupported_auth_method",
      detail: `authMethod=${facts.connection.authMethod}`,
    };
  }
  // 6. contract 完整性
  if (
    computeToolExecutionContractDigest(facts.revision.contract) !==
    facts.revision.executionContractDigest
  ) {
    return {
      executable: false,
      reasonCode: "execution_contract_integrity",
      detail: "contract digest 与冻结 digest 不一致",
    };
  }
  return { executable: true, executorKind };
}
