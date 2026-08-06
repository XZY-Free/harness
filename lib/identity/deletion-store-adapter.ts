/**
 * 可验证删除跨存储 Adapter 接口与实现（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 * （覆盖 MySQL、对象存储、向量/检索、Trace/Log 和缓存；
 * 每个 Adapter 返回删除或不可删除证据；部分失败保持 failed/partial 并可安全重试）。
 *
 * 设计：
 * - DeletionStoreAdapter：每类存储的删除接口。delete() 返回 evidenceRef（存储端删除证据），
 * 或标记 retained（共享资源保留，不删除）。失败抛 DeletionStoreError（executor 标记 failed，可重试）。
 * - FailClosedDeletionStoreAdapter：默认实现，所有 delete 抛错（fail-closed）。
 * 生产环境注入真实 Adapter（mysql 走主库行删除、object_storage 走对象删除、vector_search 走索引删除等）。
 * - RecordingDeletionStoreAdapter：测试用，按配置返回 evidence / 失败 / 保留，可注入失败行为验证部分失败与重试。
 *
 * 安全边界：
 * - 默认 fail-closed：未注入 Adapter 的存储删除一律失败（不用空结果冒充成功）。
 * - Adapter 不可自报 completed；evidenceRef 由存储端产生，executor 校验非空后标记 completed。
 * - 共享 Knowledge、跨 Thread Memory、用户原始本地文件由 Adapter 返回 retained=true，不删除。
 */
import { createHash } from "node:crypto";
import type {
 DeletionStoreType,
 DeletionSubjectType,
} from "@/lib/persistence/schema/deletion-request";

// ─── 错误类型 ──────────────────────────────────────────────

/** 存储删除错误；executor 据 retryable 决定是否重试。 */
export class DeletionStoreError extends Error {
 constructor(
 message: string,
 public readonly retryable: boolean = true,
 ) {
 super(message);
 this.name = "DeletionStoreError";
 }
}

// ─── Adapter 接口 ──────────────────────────────────────────

/** 存储删除入参。 */
export interface DeletionStoreDeleteParams {
 tenantId: string;
 subjectType: DeletionSubjectType;
 /** 该存储内资源标识（planner 生成，如 "thread:thr_001"）。 */
 subjectRef: string;
 requestId?: string;
}

/** 存储删除结果。 */
export interface DeletionStoreDeleteResult {
 /** 存储端删除证据引用（completed 必填，如 "deletion-evidence:mysql:701"）。 */
 evidenceRef: string;
 /** true 表示共享资源保留（不删除），step 标记 retained。 */
 retained?: boolean;
 /** retained=true 时的保留原因。 */
 retainReason?: string;
}

/** 跨存储删除 Adapter 接口。 */
export interface DeletionStoreAdapter {
 readonly storeType: DeletionStoreType;
 /**
 * 删除 subject 并返回证据，或标记保留。
 * @throws DeletionStoreError 删除失败（executor 标记 failed，可重试）
 */
 delete(params: DeletionStoreDeleteParams): Promise<DeletionStoreDeleteResult>;
}

// ─── Fail-closed 默认实现 ──────────────────────────────────

/**
 * Fail-closed Adapter：所有 delete 抛 DeletionStoreError（retryable）。
 *
 * 生产环境必须替换为真实 Adapter；否则删除请求所有 step 失败（不冒充成功）。
 */
export class FailClosedDeletionStoreAdapter implements DeletionStoreAdapter {
 constructor(readonly storeType: DeletionStoreType) {}

 async delete(params: DeletionStoreDeleteParams): Promise<DeletionStoreDeleteResult> {
 throw new DeletionStoreError(
 `${this.storeType} 存储未配置删除 Adapter（fail-closed）：${params.subjectType}:${params.subjectRef}`,
 true,
 );
 }
}

// ─── 测试用 Recording Adapter ──────────────────────────────

/** 单个 subjectRef 的预期行为。 */
export interface RecordingStepBehavior {
 /** "success"：返回 evidence；"fail"：抛 DeletionStoreError；"retain"：返回 retained。 */
 kind: "success" | "fail" | "retain";
 /** fail 时的错误消息。 */
 failMessage?: string;
 /** fail 时是否可重试（默认 true）。 */
 retryable?: boolean;
 /** retain 时的保留原因。 */
 retainReason?: string;
}

/** Recording Adapter 的配置：按 subjectRef（精确或前缀）匹配行为。 */
export interface RecordingAdapterConfig {
 /** 默认行为（未匹配到 subjectRef 时）；默认 "success"。 */
 defaultBehavior?: RecordingStepBehavior["kind"];
 /** defaultBehavior 为 "fail" 时的默认错误消息。 */
 defaultFailMessage?: string;
 /** defaultBehavior 为 "fail" 时的默认可重试性（默认 true）。 */
 defaultRetryable?: boolean;
 /** defaultBehavior 为 "retain" 时的默认保留原因。 */
 defaultRetainReason?: string;
 /** 按 subjectRef 精确匹配的行为。 */
 exact?: Record<string, RecordingStepBehavior>;
 /** 按前缀匹配的行为（如 "artifact:" 全部保留）。 */
 prefixes?: Array<{ prefix: string; behavior: RecordingStepBehavior }>;
 /** 调用计数到指定次数后才失败（用于验证重试：第 N 次成功）。 */
 succeedOnAttempt?: Record<string, number>;
}

/**
 * 测试用 Recording Adapter：按配置返回 evidence / 失败 / 保留。
 *
 * - 记录所有 delete 调用（subjectRef → 调用次数），供测试断言重试与幂等。
 * - succeedOnAttempt：某 subjectRef 第 N 次调用才成功（前几次失败），用于验证重试。
 */
export class RecordingDeletionStoreAdapter implements DeletionStoreAdapter {
 readonly storeType: DeletionStoreType;
 private readonly config: RecordingAdapterConfig;
 private readonly callCounts = new Map<string, number>();

 constructor(storeType: DeletionStoreType, config: RecordingAdapterConfig = {}) {
 this.storeType = storeType;
 this.config = config;
 }

 /** 查询某 subjectRef 的调用次数（验证重试与幂等）。 */
 getCallCount(subjectRef: string): number {
 return this.callCounts.get(subjectRef) ?? 0;
 }

 /** 总调用次数。 */
 getTotalCallCount(): number {
 let total = 0;
 for (const count of this.callCounts.values()) total += count;
 return total;
 }

 async delete(params: DeletionStoreDeleteParams): Promise<DeletionStoreDeleteResult> {
 const count = (this.callCounts.get(params.subjectRef) ?? 0) + 1;
 this.callCounts.set(params.subjectRef, count);

 // succeedOnAttempt：达到指定次数才成功
 const targetAttempt = this.config.succeedOnAttempt?.[params.subjectRef];
 if (targetAttempt !== undefined && count < targetAttempt) {
 throw new DeletionStoreError(
 `${this.storeType} 模拟失败（第 ${count}/${targetAttempt} 次）：${params.subjectRef}`,
 true,
 );
 }

 const behavior = this.resolveBehavior(params.subjectRef);
 if (behavior.kind === "fail") {
 throw new DeletionStoreError(
 behavior.failMessage ?? `${this.storeType} 模拟失败：${params.subjectRef}`,
 behavior.retryable ?? true,
 );
 }
 if (behavior.kind === "retain") {
 return {
 evidenceRef: `deletion-evidence:${this.storeType}:retained:${shortHash(params.subjectRef)}`,
 retained: true,
 retainReason: behavior.retainReason ?? "共享资源保留",
 };
 }
 return {
 evidenceRef: `deletion-evidence:${this.storeType}:${shortHash(params.subjectRef)}:${count}`,
 };
 }

 private resolveBehavior(subjectRef: string): RecordingStepBehavior {
 const exact = this.config.exact?.[subjectRef];
 if (exact) return exact;
 if (this.config.prefixes) {
 for (const p of this.config.prefixes) {
 if (subjectRef.startsWith(p.prefix)) return p.behavior;
 }
 }
 const kind = this.config.defaultBehavior ?? "success";
 if (kind === "fail") {
 return {
 kind,
 failMessage: this.config.defaultFailMessage,
 retryable: this.config.defaultRetryable,
 };
 }
 if (kind === "retain") {
 return {
 kind,
 retainReason: this.config.defaultRetainReason,
 };
 }
 return { kind };
 }
}

// ─── 工具 ──────────────────────────────────────────────────

/** 计算短 hash（用于 evidenceRef，避免泄露完整 subjectRef）。 */
function shortHash(input: string): string {
 return createHash("sha256").update(input, "utf-8").digest("hex").slice(0, 12);
}
