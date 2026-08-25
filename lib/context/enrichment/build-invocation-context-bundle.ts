/**
 * Invocation Context Bundle 构建器（Context Enrichment，05 §6–§9 / 01 §10）。
 *
 * 流程：
 * ```text
 * Binding → load exact InvocationContextContract（resolveBindingContextContract）
 * → enumerate available platform context
 * → policy/permission filter
 * → build allowed context bundle
 * ```
 *
 * 关键不变量：
 * - Contract 必须来自 Binding 冻结 Snapshot（调用方负责，本模块不读"最新 Descriptor"）；
 * - trusted ExecutionSubject 只能由认证 Principal 生成（05 §9），客户端不可伪造；
 * - required：context 缺失 fail / policy 拒绝 deny（05 §8）；
 * - preferred：缺失 continue（omitted 记原因）；
 * - accepted：不默认全量发送，仅当本次任务显式选择时供给；
 * - 不复制完整 Context 内容进 Binding；Bundle 每项可审计
 *   （contextKind / provenance / trusted / policy decision / supplied|omitted reason，05 §7）。
 *
 * 复用现有 Context 体系（ContextHandle 等），不创建第二 Context 系统。
 */

import type { InvocationContextContract } from "@/lib/agents/domain/agent-descriptor";

/** 认证 Principal（lib/identity/resolver）的可信主体信息。 */
export interface TrustedExecutionSubject {
  userIdentityId: string;
  externalSubject: string;
  email: string;
  displayName: string | null;
}

/** 本次 Invocation 的平台可用上下文来源（由 Harness 组装，不含任何客户端自报 trusted 值）。 */
export interface PlatformContextEnvironment {
  tenantId: string;
  /** 认证 Principal 生成的 trusted ExecutionSubject；null = 本次调用无可信主体。 */
  executionSubject: TrustedExecutionSubject | null;
  now: Date;
  timezone?: string | null;
  locale?: string | null;
  /** 会话引用（contextKind=conversation_context 的 handle/reference，按现有 Context 体系）。 */
  conversationContextRef?: string | null;
  /** 附件引用集合（contextKind=attachment_references）。 */
  attachmentRefs?: string[];
  /** 工作区引用（contextKind=workspace_context）。 */
  workspaceContextRef?: string | null;
}

/** Policy/Permission 决策（05 §8：Agent Wants ≠ Agent Is Allowed To Receive）。 */
export type ContextPolicyDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/** Policy 过滤器：按 contextKind 判定是否允许发送给 Agent。 */
export type ContextPolicyFilter = (contextKind: string) => ContextPolicyDecision;

/** 默认 filter：全允许（policy 决策记录为 default_allow）。 */
export const allowAllContextPolicyFilter: ContextPolicyFilter = () => ({ decision: "allow" });

export interface ContextBundleEntry {
  contextKind: string;
  necessity: "required" | "preferred" | "accepted";
  /** 来源：platform（平台权威事实）| principal（认证 Principal）。 */
  provenance: "platform" | "principal";
  /** 平台权威或认证主体生成（客户端自报值绝不置 true）。 */
  trusted: boolean;
  policyDecision: { decision: "allow" } | { decision: "deny"; reason: string };
  supplied: boolean;
  /** supplied=false 时的省略原因（可审计，05 §7）。 */
  omissionReason: "not_available" | "policy_denied" | "not_selected" | null;
  /** 供给内容/引用（supplied=false 为 null；按现有 Context 体系存 reference 而非全文）。 */
  value: unknown;
}

export interface InvocationContextBundle {
  entries: ContextBundleEntry[];
}

export class RequiredContextUnavailableError extends Error {
  constructor(readonly contextKind: string) {
    super(`required context 不可用: ${contextKind}`);
    this.name = "RequiredContextUnavailableError";
  }
}

export class RequiredContextDeniedError extends Error {
  constructor(
    readonly contextKind: string,
    readonly reason: string,
  ) {
    super(`required context 被 Policy 拒绝: ${contextKind} (${reason})`);
    this.name = "RequiredContextDeniedError";
  }
}

export interface BuildContextBundleInput {
  contract: InvocationContextContract;
  environment: PlatformContextEnvironment;
  policyFilter?: ContextPolicyFilter;
  /**
   * accepted 上下文的显式选择集合（05 §8：Harness 判断当前任务需要才提供）。
   * 不传 → accepted 一律 not_selected（不默认全量发送）。
   */
  selectedAcceptedContextKinds?: string[];
}

/**
 * 构建 Invocation Context Bundle。
 *
 * 逐一处理 Contract 声明（含 provider/operator 合并结果，去重按首次声明优先）：
 * required 缺失 → RequiredContextUnavailableError；required 被 deny → RequiredContextDeniedError；
 * preferred 缺失/被拒 → omitted continue；accepted 未显式选择 → not_selected。
 */
export function buildInvocationContextBundle(
  input: BuildContextBundleInput,
): InvocationContextBundle {
  const { contract, environment } = input;
  const policyFilter = input.policyFilter ?? allowAllContextPolicyFilter;
  const selectedAccepted = new Set(input.selectedAcceptedContextKinds ?? []);

  // 声明去重：同一 contextKind 以首次声明为准（provider 合并已由 canonicalize 完成，
  // 这里防御运行期重复声明）。
  const seen = new Set<string>();
  const declarations = contract.contexts.filter((d) => {
    if (seen.has(d.contextKind)) return false;
    seen.add(d.contextKind);
    return true;
  });

  const entries = declarations.map((declaration) => {
    const policyDecision = policyFilter(declaration.contextKind);
    const available = enumeratePlatformContext(declaration.contextKind, environment);
    const policyDenied = policyDecision.decision === "deny";

    // required：缺失 fail；被拒 deny（05 §8，不得因 Agent required 绕开策略）。
    if (declaration.necessity === "required") {
      if (policyDenied) {
        throw new RequiredContextDeniedError(
          declaration.contextKind,
          (policyDecision as { decision: "deny"; reason: string }).reason,
        );
      }
      if (!available.available) {
        throw new RequiredContextUnavailableError(declaration.contextKind);
      }
      return suppliedEntry(declaration, environment, policyDecision, available.value);
    }

    // preferred：有且允许 → supply；缺失/被拒 → omitted continue。
    if (declaration.necessity === "preferred") {
      if (policyDenied) {
        return omittedEntry(declaration, policyDecision, "policy_denied");
      }
      if (!available.available) {
        return omittedEntry(declaration, policyDecision, "not_available");
      }
      return suppliedEntry(declaration, environment, policyDecision, available.value);
    }

    // accepted：仅当本次任务显式选择且允许且可用 → supply；否则 not_selected。
    if (!selectedAccepted.has(declaration.contextKind)) {
      return omittedEntry(declaration, policyDecision, "not_selected");
    }
    if (policyDenied) {
      return omittedEntry(declaration, policyDecision, "policy_denied");
    }
    if (!available.available) {
      return omittedEntry(declaration, policyDecision, "not_available");
    }
    return suppliedEntry(declaration, environment, policyDecision, available.value);
  });

  return { entries };
}

// ─── 平台可用上下文枚举（05 §8：Declared ∩ Available）────────────

/**
 * 按现有平台模型枚举可用上下文。trusted 值只来自平台权威事实或认证 Principal；
 * 客户端自报值不进入本函数（environment 由 Harness 组装）。
 */
function enumeratePlatformContext(
  contextKind: string,
  environment: PlatformContextEnvironment,
): { available: boolean; value?: unknown } {
  switch (contextKind) {
    case "execution_subject":
      return environment.executionSubject
        ? { available: true, value: { ...environment.executionSubject } }
        : { available: false };
    case "tenant_context":
      return { available: true, value: { tenantId: environment.tenantId } };
    case "current_datetime":
      return { available: true, value: environment.now.toISOString() };
    case "timezone":
      return environment.timezone
        ? { available: true, value: environment.timezone }
        : { available: false };
    case "locale":
      return environment.locale
        ? { available: true, value: environment.locale }
        : { available: false };
    case "conversation_context":
      return environment.conversationContextRef
        ? { available: true, value: environment.conversationContextRef }
        : { available: false };
    case "conversation_summary":
      // 本轮无摘要源（Memory/Summary 专题成熟后接入）；fail-closed 不伪造。
      return { available: false };
    case "attachment_references":
      return environment.attachmentRefs && environment.attachmentRefs.length > 0
        ? { available: true, value: environment.attachmentRefs }
        : { available: false };
    case "workspace_context":
      return environment.workspaceContextRef
        ? { available: true, value: environment.workspaceContextRef }
        : { available: false };
    case "organization_context":
    case "memory_context":
    case "knowledge_context":
      // Memory/Knowledge 专题未成熟（01 §8）；不伪装可用。
      return { available: false };
    default:
      // 未知 contextKind：平台不认识 → 不可用（不崩溃，required 会 fail-closed）。
      return { available: false };
  }
}

function suppliedEntry(
  declaration: { contextKind: string; necessity: "required" | "preferred" | "accepted" },
  environment: PlatformContextEnvironment,
  policyDecision: ContextPolicyDecision,
  value: unknown,
): ContextBundleEntry {
  return {
    contextKind: declaration.contextKind,
    necessity: declaration.necessity,
    provenance: declaration.contextKind === "execution_subject" ? "principal" : "platform",
    // trusted：平台权威或认证主体生成。execution_subject 必有 principal（available 才 supply）。
    trusted: true,
    policyDecision,
    supplied: true,
    omissionReason: null,
    value,
  };
}

function omittedEntry(
  declaration: { contextKind: string; necessity: "required" | "preferred" | "accepted" },
  policyDecision: ContextPolicyDecision,
  omissionReason: "not_available" | "policy_denied" | "not_selected",
): ContextBundleEntry {
  return {
    contextKind: declaration.contextKind,
    necessity: declaration.necessity,
    provenance: "platform",
    trusted: false,
    policyDecision,
    supplied: false,
    omissionReason,
    value: null,
  };
}
