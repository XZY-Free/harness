import type { PlannedStep } from "@/lib/identity/deletion-request-queries";
/**
 * 删除规划器（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 *         （删除请求先解析对象关系与 Legal Hold，再进入各存储 Adapter；
 *           Legal Hold 不扩大到无关对象：仅匹配的 target 被阻止删除；
 *           共享 Knowledge、跨 Thread Memory、用户原始本地文件不因单个 Thread 删除而清除）。
 *
 * 职责：
 * - planDeletion：解析 subject → 跨存储 step 计划；Legal Hold 命中时返回 blockedReasonCodes。
 * - 解析对象关系图：subject → 各存储 subjectRef（mysql/object_storage/vector_search/trace_log/cache）。
 * - Legal Hold 阻止判断：tenant 级 + subject 级（thread/artifact）Hold active 时阻止。
 * - 共享资源保留：knowledge/cross-thread memory 生成 retained step（不删除，记录原因）。
 *
 * 生命周期优先级：active Legal Hold > 法规保留 > 已受理删除请求 > 默认清理。
 */
import { isLegalHoldActive } from "@/lib/identity/legal-hold-queries";
import {
  DELETION_STORE_TYPES,
  type DeletionDeleteMode,
  type DeletionStoreType,
  type DeletionSubjectType,
} from "@/lib/persistence/schema/deletion-request";
import type { LegalHoldTargetType } from "@/lib/persistence/schema/retention-policy";

// ─── 规划结果 ──────────────────────────────────────────────

export interface DeletionPlan {
  /** 阻塞原因码（Legal Hold 命中时非空，此时 steps 为空，请求进入 blocked_by_hold）。 */
  blockedReasonCodes: string[];
  /** 规划的步骤（blockedReasonCodes 非空时为空数组）。 */
  steps: PlannedStep[];
}

// ─── subject → Legal Hold target 映射 ──────────────────────

/**
 * subject 类型 → Legal Hold target 类型映射（仅可直接挂 Hold 的 subject）。
 * - thread → thread，artifact → artifact。
 * - memory_entry/user/retention_scope/user_data_export_scope 无直接 Hold target，
 *   仅受 tenant 级 Hold 约束。
 */
const SUBJECT_HOLD_TARGET: Partial<Record<DeletionSubjectType, LegalHoldTargetType>> = {
  thread: "thread",
  artifact: "artifact",
};

// ─── subject → 跨存储 step 规划 ─────────────────────────────

/**
 * 为 subject 生成各存储的删除 step。
 *
 * 规则：
 * - 每类 subject 在相关存储生成一条 pending step（subjectRef 编码对象标识）。
 * - 不相关的存储生成 skipped step（如 memory_entry 在 trace_log 无数据）。
 * - 共享资源（knowledge、cross-thread memory）生成 retained step（不删除，记录原因）。
 * - 不写 ThreadEvent 冒充已删除。
 */
function buildStepsForSubject(subjectType: DeletionSubjectType, subjectId: string): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const ref = (kind: string) => `${kind}:${subjectId}`;
  const skip = (storeType: DeletionStoreType, reason: string): PlannedStep => ({
    storeType,
    subjectRef: `skip:${storeType}:${subjectType}:${subjectId}`,
    stepState: "skipped",
    failureReason: reason,
  });
  const retain = (storeType: DeletionStoreType, kind: string, reason: string): PlannedStep => ({
    storeType,
    subjectRef: ref(kind),
    stepState: "retained",
    failureReason: reason,
  });
  const pending = (storeType: DeletionStoreType, kind: string): PlannedStep => ({
    storeType,
    subjectRef: ref(kind),
    stepState: "pending",
  });

  switch (subjectType) {
    case "thread": {
      // 线程自身数据：5 类存储各一条 pending step。
      steps.push(pending("mysql", "thread"));
      steps.push(pending("object_storage", "thread"));
      steps.push(pending("vector_search", "thread"));
      steps.push(pending("trace_log", "thread"));
      steps.push(pending("cache", "thread"));
      // 共享资源保留：knowledge 与 cross-thread memory 不因单线程删除而清除。
      steps.push(retain("object_storage", "knowledge:shared", "共享 Knowledge 不随 Thread 删除"));
      steps.push(
        retain("vector_search", "knowledge:shared", "共享 Knowledge 索引不随 Thread 删除"),
      );
      break;
    }
    case "memory_entry": {
      // 记忆条目：mysql/vector_search/cache 删除；object_storage/trace_log 无数据。
      steps.push(pending("mysql", "memory"));
      steps.push(skip("object_storage", "memory_entry 无对象存储正文"));
      steps.push(pending("vector_search", "memory"));
      steps.push(skip("trace_log", "memory_entry 无 Trace/Log"));
      steps.push(pending("cache", "memory"));
      break;
    }
    case "artifact": {
      // 制品：mysql 元数据 + object_storage 正文 + cache 失效；vector_search/trace_log 无数据。
      steps.push(pending("mysql", "artifact"));
      steps.push(pending("object_storage", "artifact"));
      steps.push(skip("vector_search", "artifact 无向量索引"));
      steps.push(skip("trace_log", "artifact 无 Trace/Log"));
      steps.push(pending("cache", "artifact"));
      break;
    }
    case "user": {
      // 用户数据：跨存储清理（mysql 行 + object_storage 文件 + vector_search embedding + trace_log + cache）。
      steps.push(pending("mysql", "user"));
      steps.push(pending("object_storage", "user"));
      steps.push(pending("vector_search", "user"));
      steps.push(pending("trace_log", "user"));
      steps.push(pending("cache", "user"));
      // 用户原始本地文件不删除（仅在服务端清理用户产生数据）。
      steps.push(retain("object_storage", "user:local-files", "用户原始本地文件不删除"));
      break;
    }
    case "retention_scope": {
      // 保留期到期范围清理：5 类存储各一条 pending step（subjectId 编码范围）。
      steps.push(pending("mysql", "retention_scope"));
      steps.push(pending("object_storage", "retention_scope"));
      steps.push(pending("vector_search", "retention_scope"));
      steps.push(pending("trace_log", "retention_scope"));
      steps.push(pending("cache", "retention_scope"));
      break;
    }
    case "user_data_export_scope": {
      // 导出范围：mysql 删导出记录 + cache 失效；object_storage/vector_search/trace_log 无数据。
      steps.push(pending("mysql", "user_data_export"));
      steps.push(skip("object_storage", "user_data_export_scope 无对象存储正文"));
      steps.push(skip("vector_search", "user_data_export_scope 无向量索引"));
      steps.push(skip("trace_log", "user_data_export_scope 无 Trace/Log"));
      steps.push(pending("cache", "user_data_export"));
      break;
    }
    default: {
      // 兜底：5 类存储各一条 pending step。
      for (const storeType of DELETION_STORE_TYPES) {
        steps.push(pending(storeType, subjectType));
      }
    }
  }
  return steps;
}

// ─── 规划入口 ──────────────────────────────────────────────

/**
 * 规划删除：解析对象关系图 + Legal Hold 阻止判断 + step 计划生成。
 *
 * Legal Hold 阻止规则（不扩大到无关对象）：
 * - tenant 级 active Hold → 阻止该租户所有删除。
 * - subject 级 active Hold（thread/artifact）→ 仅阻止该 subject 删除。
 * - 命中任一 Hold → blockedReasonCodes=["ACTIVE_LEGAL_HOLD"]，steps 为空。
 *
 * @returns DeletionPlan（blockedReasonCodes 非空时 steps 为空）
 */
export async function planDeletion(params: {
  tenantId: string;
  subjectType: DeletionSubjectType;
  subjectId: string;
  deleteMode: DeletionDeleteMode;
}): Promise<DeletionPlan> {
  const blockedReasonCodes: string[] = [];

  // 1. tenant 级 Legal Hold 检查（阻止该租户所有删除）。
  const tenantHeld = await isLegalHoldActive(params.tenantId, "tenant", params.tenantId);
  if (tenantHeld) {
    blockedReasonCodes.push("ACTIVE_LEGAL_HOLD");
  }

  // 2. subject 级 Legal Hold 检查（仅 thread/artifact 有直接 Hold target）。
  const subjectHoldTarget = SUBJECT_HOLD_TARGET[params.subjectType];
  if (subjectHoldTarget) {
    const subjectHeld = await isLegalHoldActive(
      params.tenantId,
      subjectHoldTarget,
      params.subjectId,
    );
    if (subjectHeld && !blockedReasonCodes.includes("ACTIVE_LEGAL_HOLD")) {
      blockedReasonCodes.push("ACTIVE_LEGAL_HOLD");
    }
  }

  // 3. 命中 Hold → 返回阻塞，不生成 steps（请求进入 blocked_by_hold，Hold 解除后重新规划）。
  if (blockedReasonCodes.length > 0) {
    return { blockedReasonCodes, steps: [] };
  }

  // 4. 生成跨存储 step 计划。
  const steps = buildStepsForSubject(params.subjectType, params.subjectId);
  return { blockedReasonCodes, steps };
}
