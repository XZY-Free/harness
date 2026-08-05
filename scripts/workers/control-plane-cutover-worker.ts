#!/usr/bin/env npx tsx
/**
 * §7.2: Control Plane Cutover Worker — 异步执行 Cutover Item 资格重建。
 *
 * 独立进程入口，不依赖 Next.js 请求生命周期。
 * 领取语义：FOR UPDATE SKIP LOCKED + 租约 + 退避。
 *
 * 工作：
 * 1. 领取 pending/failed 的 CutoverItem
 * 2. 执行资格重建（createReplacementRevision + readiness check）
 * 3. 保存结果 + 清除租约
 * 4. 检查 Plan 是否所有 Item 都 ready → 推进 Plan 状态
 *
 * 用法：npx tsx scripts/workers/control-plane-cutover-worker.ts
 */

import { mysqlCutoverStore } from "@/lib/control-plane/cutover/persistence/mysql-cutover-store";
import { createCutoverExecutor } from "@/lib/control-plane/cutover/application/execute-cutover";
import {
  computeNextAttemptAt,
} from "@/lib/control-plane/cutover/domain/cutover-item";
import {
  isValidPlanTransition,
} from "@/lib/control-plane/cutover/domain/cutover-plan";
import { logger } from "@/lib/logger";

/** Worker 配置。 */
interface CutoverWorkerConfig {
  workerId: string;
  /** 处理的租户 ID（单租户模式）。 */
  tenantId: string;
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxItemAttempts: number;
}

const DEFAULT_CONFIG: CutoverWorkerConfig = {
  workerId: `cutover-worker-${process.pid}`,
  tenantId: process.env.CUTOVER_TENANT_ID ?? "",
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 5_000,
  maxItemAttempts: 5,
};

/** 创建 Cutover Worker 主循环。 */
export function createCutoverWorker(configOverrides?: Partial<CutoverWorkerConfig>) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const store = mysqlCutoverStore;

  // §7.2: Cutover 执行器配置 — 需要注入真实依赖
  const executor = createCutoverExecutor({
    store,
    // 这些依赖需要从实际模块注入
    createReplacementAgentRevision: async () => {
      throw new Error("createReplacementAgentRevision: 需要注入真实实现");
    },
    createReplacementRuntimeRevision: async () => {
      throw new Error("createReplacementRuntimeRevision: 需要注入真实实现");
    },
    resolveArtifactEvidence: async () => {
      throw new Error("resolveArtifactEvidence: 需要注入真实实现");
    },
    activateRouteSet: async () => {
      throw new Error("activateRouteSet: 需要注入真实实现");
    },
    maxItemAttempts: config.maxItemAttempts,
  });

  let running = false;

  return {
    async start() {
      running = true;
      logger.info("[cutover-worker] 启动", {
        workerId: config.workerId,
        batchSize: config.batchSize,
        leaseMs: config.leaseMs,
        pollIntervalMs: config.pollIntervalMs,
      });

      while (running) {
        try {
          const processed = await poll();
          if (processed === 0) {
            await sleep(config.pollIntervalMs);
          }
        } catch (error) {
          logger.error("[cutover-worker] 轮询错误", {
            error: String(error),
          });
          await sleep(config.pollIntervalMs);
        }
      }

      logger.info("[cutover-worker] 停止");
    },

    stop() {
      running = false;
    },
  };

  /** 单轮轮询：领取 Item → 执行 → 检查 Plan 状态。 */
  async function poll(): Promise<number> {
    const now = new Date();

    // 领取可处理的 Item
    const items = await store.claimItems({
      tenantId: config.tenantId,
      workerId: config.workerId,
      leaseMs: config.leaseMs,
      batchSize: config.batchSize,
      now,
    });

    if (items.length === 0) return 0;

    for (const item of items) {
      try {
        const result = await executor(item);

        logger.info("[cutover-worker] Item 执行完成", {
          itemId: item.id,
          subjectType: item.subjectType,
          newState: result.newState,
        });

        // Item 完成后检查 Plan 是否所有 Item 都 ready
        if (result.newState === "ready") {
          await checkPlanProgress(item.planId);
        }

        // 释放租约
        await store.releaseLease({ itemId: item.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[cutover-worker] Item 执行错误", {
          itemId: item.id,
          error: message,
        });

        // 标记失败 + 退避
        const backoff = computeNextAttemptAt(item.attemptCount);
        await store.updateItemState({
          itemId: item.id,
          state: "failed",
          nextAttemptAt: backoff,
          lastError: message,
        });

        await store.releaseLease({ itemId: item.id });
      }
    }

    return items.length;
  }

  /** 检查 Plan 进度 — 所有 Item ready 时推进 Plan 状态。 */
  async function checkPlanProgress(planId: string): Promise<void> {
    const allItems = await store.listItemsByPlan(planId);
    const allReady = allItems.every((item) => item.state === "ready");

    if (!allReady) return;

    // 获取 Plan 当前状态（从 item 中获取 tenantId）
    const plan = await store.getPlanById({ tenantId: config.tenantId, planId });
    if (!plan) return;

    // 所有 Item ready → 推进到 ready_to_activate
    if (isValidPlanTransition(plan.state, "ready_to_activate")) {
      await store.updatePlanState({
        planId,
        state: "ready_to_activate",
      });
      logger.info("[cutover-worker] Plan 所有 Item ready，推进到 ready_to_activate", {
        planId,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 直接运行入口 ──────────────────────────────────────────
if (require.main === module) {
  const worker = createCutoverWorker();
  worker.start().catch((error) => {
    console.error("[cutover-worker] 启动失败:", error);
    process.exit(1);
  });

  process.on("SIGTERM", () => worker.stop());
  process.on("SIGINT", () => worker.stop());
}
