/**
 * Hosted Provisioning Worker — 异步执行 Hosted 供应 Saga。
 *
 * 独立进程入口，不依赖 Next.js 请求生命周期。
 * 领取语义：FOR UPDATE SKIP LOCKED + 租约 + 退避。
 * Permanent Failure 与 Retryable Failure 分离。
 *
 * : 使用 Gateway 接口替代旧单体 HostedRuntimeControlPlane。
 */

import { logger } from "@/lib/logger";
import { createHostedProvisioningSaga } from "@/lib/runtime/provisioning/hosted-provisioning-saga";
import {
 classifyProvisioningError,
 computeProvisioningBackoff,
} from "@/lib/runtime/domain/hosted-provisioning-request";
import { createMysqlHostedGateways } from "@/lib/runtime/infrastructure/mysql-hosted-gateways";
import { mysqlHostedProvisioningRequestStore } from "@/lib/runtime/persistence/mysql-hosted-provisioning-request-store";
import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "@/lib/runtime/persistence/hosted-provisioning-request-store";
import type { SagaStepResult } from "@/lib/runtime/provisioning/hosted-provisioning-saga";

/** Worker 配置。 */
export interface HostedProvisioningWorkerConfig {
 workerId: string;
 /** 每轮领取的请求数量。 */
 batchSize: number;
 /** 租约时长（毫秒）。 */
 leaseMs: number;
 /** 轮询间隔（毫秒）。 */
 pollIntervalMs: number;
 /** 最大重试次数。 */
 maxAttempts: number;
 /** 退避基数（毫秒）。 */
 baseBackoffMs: number;
 /** 退避上限（毫秒）。 */
 maxBackoffMs: number;
}

const DEFAULT_CONFIG: HostedProvisioningWorkerConfig = {
 workerId: `hosted-provisioner-${process.pid}`,
 batchSize: 5,
 leaseMs: 120_000, // 2 分钟租约
 pollIntervalMs: 5_000, // 5 秒轮询
 maxAttempts: 10,
 baseBackoffMs: 10_000,
 maxBackoffMs: 600_000, // 10 分钟上限
};

export interface HostedProvisioningWorkerDependencies {
 store?: HostedProvisioningRequestStore;
 saga?: (request: HostedProvisioningRequestRow) => Promise<SagaStepResult>;
 now?: () => Date;
 sleep?: (ms: number) => Promise<void>;
}

/**
 * 创建 Worker 主循环。
 */
export function createHostedProvisioningWorker(
 configOverrides?: Partial<HostedProvisioningWorkerConfig>,
 dependencies: HostedProvisioningWorkerDependencies = {},
) {
 const config = { ...DEFAULT_CONFIG, ...configOverrides };
 const store = dependencies.store ?? mysqlHostedProvisioningRequestStore;

 // : 使用 Gateway 接口替代旧单体
 const saga =
 dependencies.saga ??
 createHostedProvisioningSaga({
 gateways: createMysqlHostedGateways(),
 store,
 maxAttempts: config.maxAttempts,
 workerId: config.workerId,
 });
 const now = dependencies.now ?? (() => new Date());
 const wait = dependencies.sleep ?? sleep;

 let running = false;

 return {
 /** 启动 Worker 主循环。 */
 async start() {
 running = true;
 logger.info("[hosted-provisioning-worker] 启动", {
 workerId: config.workerId,
 batchSize: config.batchSize,
 leaseMs: config.leaseMs,
 pollIntervalMs: config.pollIntervalMs,
 });

 while (running) {
 try {
 const processed = await poll();
 if (processed === 0) {
 // 无待处理请求，等待下次轮询
 await wait(config.pollIntervalMs);
 }
 // 有请求时不等待，立即下一轮（直到无请求才休眠）
 } catch (error) {
 logger.error("[hosted-provisioning-worker] 轮询错误", {
 error: String(error),
 });
 await wait(config.pollIntervalMs);
 }
 }

 logger.info("[hosted-provisioning-worker] 停止");
 },

 /** 优雅停止。 */
 stop() {
 running = false;
 },

 /** 执行一轮正式领取与处理，供进程入口和同构测试共同使用。 */
 async pollOnce() {
 return poll();
 },
 };

 /** 单轮轮询：领取 → 执行 → 原子提交状态并清除租约。 */
 async function poll(): Promise<number> {
 const claimedAt = now();
 const requests = await store.claimRequests({
 workerId: config.workerId,
 leaseMs: config.leaseMs,
 batchSize: config.batchSize,
 now: claimedAt,
 });

 if (requests.length === 0) return 0;

 for (const request of requests) {
 try {
 const result = await saga(request);

 logger.info("[hosted-provisioning-worker] 步骤完成", {
 requestId: request.id,
 step: result.step,
 newState: result.newState,
 });

 } catch (error) {
 // Saga 本身抛错（不应该发生，saga 内部已处理）
 const classification = classifyProvisioningError(error);
 const message =
 classification.category === "permanent"
 ? String(error)
 : error instanceof Error
 ? error.message
 : String(error);

 if (classification.category === "permanent" || request.attemptCount >= config.maxAttempts) {
 await store.updateState({
 requestId: request.id,
 workerId: config.workerId,
 state: "permanent_failed",
 lastError: message,
 lastAttemptAt: now(),
 leaseOwner: null,
 leaseExpiresAt: null,
 });
 } else {
 const backoff = computeProvisioningBackoff(
 request.attemptCount,
 config.baseBackoffMs,
 config.maxBackoffMs,
 );
 await store.updateState({
 requestId: request.id,
 workerId: config.workerId,
 state: "retryable_failed",
 nextAttemptAt: backoff,
 lastError: message,
 lastAttemptAt: now(),
 leaseOwner: null,
 leaseExpiresAt: null,
 });
 }
 }
 }

 return requests.length;
 }
}

function sleep(ms: number): Promise<void> {
 return new Promise((resolve) => setTimeout(resolve, ms));
}
