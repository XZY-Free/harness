/**
 * ：Server 端取消服务。
 *
 * 实现 03-agent-bridge-security.md "停止并接管" 流程的 Server 端逻辑：
 *
 * 1. Desktop 用户点击"停止并接管" → Desktop 释放本地 AI 锁 → 发送 cancel_command 到 Server
 * 2. Server.requestCancel：
 * a. 校验请求设备是当前 lease holder（防跨设备取消）
 * b. 释放 Server lease
 * c. 将 runId 标记为 cancelled（防迟到 RPC 结果进入 Agent 上下文）
 * d. 通过 callback 通知 Desktop command_cancelled
 * 3. Server.serverCancel（Server 主动取消，如超时/关停）：
 * a. 强制撤销 lease
 * b. 将 runId 标记为 cancelled
 * c. 通知 Desktop
 *
 * 安全约束：
 * - 只有持有 lease 的设备能发起 requestCancel（防跨设备 DoS 攻击）
 * - cancelled runId 集合有 TTL，避免内存无限增长
 * - 迟到的 RPC 结果（cancel 后到达）应被丢弃，不进入 Agent 上下文
 */
import type { BrowserLease } from "../desktop/lease";

/**
 * CancelService 依赖的 LeaseService 接口（结构化类型，便于测试 mock）。
 */
interface LeaseServiceLike {
 getLeaseHolder(threadId: string): BrowserLease | null;
 releaseLease(threadId: string, deviceId: string, now: number): boolean;
 revokeLease(threadId: string): boolean;
}

/**
 * cancelled runId 记录。
 *
 * 用于过滤迟到的 RPC 结果（cancel 后到达的结果不进入 Agent 上下文）。
 */
interface CancelledRun {
 threadId: string;
 runId: string;
 cancelledAt: number;
 /** 过期时间（epoch ms），过期后从集合移除 */
 expiresAt: number;
}

/**
 * cancel 返回类型。
 */
export interface CancelResult {
 /** 是否成功取消 */
 cancelled: boolean;
 /** 被取消的 runId（无则 null） */
 runId: string | null;
 /** 失败时的错误码 */
 code?: string;
}

/**
 * 默认 cancelled 记录 TTL：5 分钟。
 *
 * cancelled 记录用于过滤迟到的 RPC 结果，5 分钟足以覆盖 RPC 超时窗口（30 秒）。
 */
const DEFAULT_CANCELLED_TTL_MS = 5 * 60 * 1000;

/**
 * Server 端取消服务。
 *
 * 集成 LeaseService：
 * - requestCancel：Desktop 发起取消，校验 lease holder 身份
 * - serverCancel：Server 主动取消（超时/关停）
 * - isCancelled：检查 runId 是否被取消（防迟到 RPC 结果）
 */
export class CancelService {
 private cancelledRuns = new Map<string, CancelledRun>();
 private ttlMs: number;

 constructor(
 private leaseService: LeaseServiceLike,
 ttlMs: number = DEFAULT_CANCELLED_TTL_MS,
 ) {
 this.ttlMs = ttlMs;
 }

 /**
 * Desktop 发起取消（用户"停止并接管"）。
 *
 * 流程：
 * 1. 查找 lease holder
 * 2. 校验请求设备是 lease holder（防跨设备取消）
 * 3. 释放 Server lease
 * 4. 将 runId 标记为 cancelled
 *
 * @returns cancelled=true 表示成功取消，cancelled=false 表示无 lease 或非持有设备
 */
 async requestCancel(params: {
 threadId: string;
 runId: string;
 reason: string;
 /** 发起 cancel 的设备 ID */
 deviceId: string;
 now: number;
 }): Promise<CancelResult> {
 const { threadId, runId, deviceId, now } = params;
 const lease = this.leaseService.getLeaseHolder(threadId);
 if (!lease) {
 // 无 lease：命令可能已完成，仍标记 cancelled 防迟到 RPC
 this.markCancelled(threadId, runId, now);
 return { cancelled: false, runId: null };
 }
 // 校验请求设备是 lease holder
 if (lease.deviceId !== deviceId) {
 return { cancelled: false, runId: null, code: "not_lease_holder" };
 }
 // 释放 lease
 this.leaseService.releaseLease(threadId, deviceId, now);
 // 标记 cancelled
 this.markCancelled(threadId, runId, now);
 return { cancelled: true, runId };
 }

 /**
 * Server 主动取消（超时/关停/管理员强制）。
 *
 * 不校验设备身份——Server 有权强制取消任何 lease。
 *
 * @returns cancelled=true 表示已标记 cancelled（即使无 lease 也标记，防迟到 RPC）
 */
 async serverCancel(params: {
 threadId: string;
 runId: string;
 reason: string;
 now: number;
 }): Promise<CancelResult> {
 const { threadId, runId, now } = params;
 // 撤销 lease（即使不存在也无害）
 this.leaseService.revokeLease(threadId);
 // 标记 cancelled（防迟到 RPC 结果）
 this.markCancelled(threadId, runId, now);
 return { cancelled: true, runId };
 }

 /**
 * 检查 runId 是否被取消。
 *
 * 用于过滤迟到的 RPC 结果：cancel 后到达的结果不进入 Agent 上下文。
 *
 * @param threadId thread ID
 * @param runId run ID
 * @param now 可选当前时间，默认 Date.now()
 */
 isCancelled(threadId: string, runId: string, now: number = Date.now()): boolean {
 this.cleanupExpired(now);
 const key = this.key(threadId, runId);
 return this.cancelledRuns.has(key);
 }

 /**
 * 判断 RPC 结果是否应被丢弃（runId 已 cancelled）。
 *
 * 与 isCancelled 同义，语义化方法名便于调用方理解。
 */
 shouldDropRpcResult(threadId: string, runId: string, now: number = Date.now()): boolean {
 return this.isCancelled(threadId, runId, now);
 }

 // ─── 内部 ─────────────────────────────────────

 private key(threadId: string, runId: string): string {
 return `${threadId}:${runId}`;
 }

 private markCancelled(threadId: string, runId: string, now: number): void {
 const key = this.key(threadId, runId);
 this.cancelledRuns.set(key, {
 threadId,
 runId,
 cancelledAt: now,
 expiresAt: now + this.ttlMs,
 });
 }

 private cleanupExpired(now: number): number {
 let cleaned = 0;
 for (const [key, record] of this.cancelledRuns) {
 if (record.expiresAt <= now) {
 this.cancelledRuns.delete(key);
 cleaned++;
 }
 }
 return cleaned;
 }
}
