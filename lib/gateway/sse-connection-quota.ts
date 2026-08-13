/**
 * SSE 并发连接配额管理（S12-W02）。
 *
 * 事实源：
 * - docs/architecture/security.md
 * - docs/architecture/security.md S12-W02
 *
 * 职责：
 * - 按租户、用户、Thread 维度跟踪活跃 SSE 连接数。
 * - 超过配额时返回 false，调用方返回 429 STREAM_BACKPRESSURE。
 * - 慢消费者、断开和重复连接不会无限占用连接配额（通过 acquire/release + AbortSignal 保证释放）。
 *
 * 关键约束：
 * - acquire 和 release 必须配对（route handler 在流关闭/断开时必须 release）。
 * - 配额是进程级的；多实例部署时每实例独立计数。
 * - 不静默丢持久事件：连接被拒时返回 429 + retry_after_ms，客户端应重连或使用 snapshot 恢复。
 */
/** SSE 连接配额配置。 */
export interface SSEConnectionQuotaConfig {
 /** 每租户最大并发 SSE 连接。 */
 maxPerTenant: number;
 /** 每用户最大并发 SSE 连接。 */
 maxPerUser: number;
 /** 每 Thread 最大并发 SSE 连接。 */
 maxPerThread: number;
}

/** 默认配置。 */
export const DEFAULT_SSE_QUOTA_CONFIG: SSEConnectionQuotaConfig = {
 maxPerTenant: 100,
 maxPerUser: 20,
 maxPerThread: 10,
};

/** 配额检查结果。 */
export interface SSEQuotaResult {
 /** 是否允许新连接。 */
 allowed: boolean;
 /** 重试等待毫秒（allowed=false 时有意义）。 */
 retryAfterMs: number;
 /** 被限流的维度。 */
 scope: "tenant" | "user" | "thread";
 /** 当前活跃连接数。 */
 active: number;
 /** 最大连接数。 */
 max: number;
}

/** 计数减 1；归零时删除键，避免 uniqueScopes 统计膨胀。 */
function decrementOrDelete(map: Map<string, number>, key: string): void {
 const current = map.get(key) ?? 0;
 if (current <= 1) {
 map.delete(key);
 } else {
 map.set(key, current - 1);
 }
}

/** SSE 连接配额管理器。 */
export class SSEConnectionQuota {
 private readonly tenantCounts = new Map<string, number>();
 private readonly userCounts = new Map<string, number>();
 private readonly threadCounts = new Map<string, number>();
 private readonly config: SSEConnectionQuotaConfig;

 constructor(config?: Partial<SSEConnectionQuotaConfig>) {
 this.config = { ...DEFAULT_SSE_QUOTA_CONFIG, ...config };
 }

 /**
 * 检查并获取 SSE 连接槽位。
 *
 * 调用方必须在连接关闭时调用 release。
 *
 * @param tenantId 租户 ID
 * @param userId 用户 ID
 * @param threadId Thread ID
 * @returns 配额检查结果
 */
 acquire(tenantId: string, userId: string, threadId: string): SSEQuotaResult {
 const tenantActive = this.tenantCounts.get(tenantId) ?? 0;
 const userActive = this.userCounts.get(userId) ?? 0;
 const threadActive = this.threadCounts.get(threadId) ?? 0;

 // 按最严格维度检查（任一超限即拒绝）
 if (tenantActive >= this.config.maxPerTenant) {
 return {
 allowed: false,
 retryAfterMs: 1000,
 scope: "tenant",
 active: tenantActive,
 max: this.config.maxPerTenant,
 };
 }
 if (userActive >= this.config.maxPerUser) {
 return {
 allowed: false,
 retryAfterMs: 1000,
 scope: "user",
 active: userActive,
 max: this.config.maxPerUser,
 };
 }
 if (threadActive >= this.config.maxPerThread) {
 return {
 allowed: false,
 retryAfterMs: 1000,
 scope: "thread",
 active: threadActive,
 max: this.config.maxPerThread,
 };
 }

 // 全部通过，计数+1
 this.tenantCounts.set(tenantId, tenantActive + 1);
 this.userCounts.set(userId, userActive + 1);
 this.threadCounts.set(threadId, threadActive + 1);

 return {
 allowed: true,
 retryAfterMs: 0,
 scope: "tenant",
 active: tenantActive + 1,
 max: this.config.maxPerTenant,
 };
 }

 /**
 * 释放 SSE 连接槽位。
 *
 * 必须与 acquire 配对调用。计数归零时删除 map 键，避免 uniqueScopes 统计膨胀。
 */
 release(tenantId: string, userId: string, threadId: string): void {
 decrementOrDelete(this.tenantCounts, tenantId);
 decrementOrDelete(this.userCounts, userId);
 decrementOrDelete(this.threadCounts, threadId);
 }

 /** 获取租户活跃连接数。 */
 getTenantActive(tenantId: string): number {
 return this.tenantCounts.get(tenantId) ?? 0;
 }

 /** 获取用户活跃连接数。 */
 getUserActive(userId: string): number {
 return this.userCounts.get(userId) ?? 0;
 }

 /** 获取 Thread 活跃连接数。 */
 getThreadActive(threadId: string): number {
 return this.threadCounts.get(threadId) ?? 0;
 }

 /**
 * 获取聚合快照（管理端点只读视图）。
 *
 * 返回各维度的总活跃连接数与独立 scope 数量。
 */
 getSnapshot(): {
 totalActive: { tenant: number; user: number; thread: number };
 uniqueScopes: { tenant: number; user: number; thread: number };
 } {
 let tenantTotal = 0;
 for (const count of this.tenantCounts.values()) tenantTotal += count;
 let userTotal = 0;
 for (const count of this.userCounts.values()) userTotal += count;
 let threadTotal = 0;
 for (const count of this.threadCounts.values()) threadTotal += count;
 return {
 totalActive: { tenant: tenantTotal, user: userTotal, thread: threadTotal },
 uniqueScopes: {
 tenant: this.tenantCounts.size,
 user: this.userCounts.size,
 thread: this.threadCounts.size,
 },
 };
 }

 /** 获取当前配置（管理端点只读视图）。 */
 getConfig(): SSEConnectionQuotaConfig {
 return { ...this.config };
 }

 /** 重置（测试用）。 */
 reset(): void {
 this.tenantCounts.clear();
 this.userCounts.clear();
 this.threadCounts.clear();
 }
}

/** 进程级单例。 */
let globalSSEQuota: SSEConnectionQuota | null = null;

/** 获取全局 SSE 连接配额单例。 */
export function getSSEConnectionQuota(): SSEConnectionQuota {
 if (!globalSSEQuota) {
 globalSSEQuota = new SSEConnectionQuota();
 }
 return globalSSEQuota;
}

/** 重置全局 SSE 连接配额（测试用）。 */
export function resetSSEConnectionQuota(): void {
 globalSSEQuota = null;
}
