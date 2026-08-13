/**
 * 优先级过载保护（S12-W02）。
 *
 * 事实源：
 * - docs/architecture/security.md S12-W02
 *
 * 职责：
 * - 跟踪进程级并发请求数，按优先级分级拒绝。
 * - 过载时优先保护 critical（取消/停止、UserAction ack、Audit 写入）和 high（已确认副作用核对）。
 * - normal（常规 API）和 low（SSE 订阅、导出、重查询）在过载时先被拒绝。
 * - 不伪造成功响应：被拒绝的请求必须返回 429 或 503。
 *
 * 关键约束：
 * - 临界值按 maxConcurrent 的百分比计算：超过阈值时该优先级及以下被拒绝。
 * - acquire/release 必须配对调用（使用 try/finally 或类似机制）。
 * - 进程内状态；多实例各自独立计算。
 */
/** 请求优先级。 */
export type RequestPriority = "critical" | "high" | "normal" | "low";

/** 过载保护配置。 */
export interface OverloadConfig {
 /** 最大并发请求数。 */
 maxConcurrent: number;
 /** 各优先级的拒绝阈值（占 maxConcurrent 的比例，0-1）。 */
 thresholds: Record<RequestPriority, number>;
}

/** 默认配置。 */
export const DEFAULT_OVERLOAD_CONFIG: OverloadConfig = {
 maxConcurrent: 500,
 thresholds: {
 critical: 1.0, // critical 始终接受（除非已达 maxConcurrent）
 high: 0.9, // 90% 后拒绝 high
 normal: 0.7, // 70% 后拒绝 normal
 low: 0.5, // 50% 后拒绝 low
 },
};

/** 过载检查结果。 */
export interface OverloadResult {
 /** 是否放行。 */
 allowed: boolean;
 /** 重试等待毫秒（allowed=false 时有意义）。 */
 retryAfterMs: number;
 /** 当前并发数。 */
 concurrent: number;
 /** 最大并发数。 */
 maxConcurrent: number;
 /** 请求优先级。 */
 priority: RequestPriority;
 /** 拒绝原因（allowed=false 时有意义）。 */
 reason: string;
}

/** 优先级权重顺序（critical 最高）。 */
const PRIORITY_ORDER: RequestPriority[] = ["critical", "high", "normal", "low"];

/** 过载保护器实例。 */
export class OverloadProtector {
 private concurrent = 0;
 private readonly priorityCounts: Record<RequestPriority, number> = {
 critical: 0,
 high: 0,
 normal: 0,
 low: 0,
 };
 private readonly config: OverloadConfig;

 constructor(config?: Partial<OverloadConfig>) {
 this.config = {
 maxConcurrent: config?.maxConcurrent ?? DEFAULT_OVERLOAD_CONFIG.maxConcurrent,
 thresholds: { ...DEFAULT_OVERLOAD_CONFIG.thresholds, ...config?.thresholds },
 };
 }

 /**
 * 检查是否允许通过（不计数）。
 */
 check(priority: RequestPriority): OverloadResult {
 // 已达绝对上限：即使 critical 也拒绝
 if (this.concurrent >= this.config.maxConcurrent) {
 return {
 allowed: false,
 retryAfterMs: 100,
 concurrent: this.concurrent,
 maxConcurrent: this.config.maxConcurrent,
 priority,
 reason: "max_concurrent_reached",
 };
 }

 // 按优先级阈值检查
 const threshold = this.config.maxConcurrent * this.config.thresholds[priority];
 if (this.concurrent >= threshold) {
 return {
 allowed: false,
 retryAfterMs: 200,
 concurrent: this.concurrent,
 maxConcurrent: this.config.maxConcurrent,
 priority,
 reason: "priority_threshold_reached",
 };
 }

 return {
 allowed: true,
 retryAfterMs: 0,
 concurrent: this.concurrent,
 maxConcurrent: this.config.maxConcurrent,
 priority,
 reason: "ok",
 };
 }

 /**
 * 获取过载槽位（check + acquire 原子操作）。
 *
 * 调用方必须在请求结束后调用 release(priority)。
 */
 acquire(priority: RequestPriority): OverloadResult {
 const result = this.check(priority);
 if (result.allowed) {
 this.concurrent++;
 this.priorityCounts[priority]++;
 }
 return result;
 }

 /**
 * 释放过载槽位。
 *
 * 必须与 acquire 配对调用。
 */
 release(priority: RequestPriority): void {
 if (this.concurrent > 0) this.concurrent--;
 if (this.priorityCounts[priority] > 0) this.priorityCounts[priority]--;
 }

 /** 获取当前并发数。 */
 getConcurrent(): number {
 return this.concurrent;
 }

 /** 获取各优先级并发数。 */
 getPriorityCounts(): Record<RequestPriority, number> {
 return { ...this.priorityCounts };
 }

 /** 获取当前配置（管理端点只读视图）。 */
 getConfig(): OverloadConfig {
 return {
 maxConcurrent: this.config.maxConcurrent,
 thresholds: { ...this.config.thresholds },
 };
 }

 /** 重置（测试用）。 */
 reset(): void {
 this.concurrent = 0;
 for (const p of PRIORITY_ORDER) {
 this.priorityCounts[p] = 0;
 }
 }
}

/** 进程级单例。 */
let globalOverloadProtector: OverloadProtector | null = null;

/** 获取全局过载保护器单例。 */
export function getOverloadProtector(): OverloadProtector {
 if (!globalOverloadProtector) {
 globalOverloadProtector = new OverloadProtector();
 }
 return globalOverloadProtector;
}

/** 重置全局过载保护器（测试用）。 */
export function resetOverloadProtector(): void {
 globalOverloadProtector = null;
}

/**
 * 根据操作类型推断优先级。
 *
 * - critical：取消/停止、UserAction ack、Audit 写入
 * - high：已确认副作用核对（effect reconcile）
 * - normal：常规 API（turn 创建、消息发送、查询）
 * - low：SSE 订阅、导出、重建投影、重查询
 */
export function inferPriority(method: string, path: string): RequestPriority {
 const upperMethod = method.toUpperCase();
 // 取消/停止/UserAction → critical
 if (upperMethod === "POST" && (path.includes(":cancel") || path.includes(":stop"))) {
 return "critical";
 }
 if (upperMethod === "POST" && path.includes(":ack")) {
 return "critical";
 }
 if (path.includes("/audit")) {
 return "critical";
 }

 // 已确认副作用核对 → high
 if (path.includes("/effects") || path.includes(":reconcile")) {
 return "high";
 }

 // SSE 订阅 / 导出 / 重建 → low
 if (path.includes("/events") && upperMethod === "GET") {
 return "low";
 }
 if (path.includes("/exports") || path.includes(":rebuild") || path.includes(":replay")) {
 return "low";
 }

 // 默认 → normal
 return "normal";
}
