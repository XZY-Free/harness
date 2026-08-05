/**
 * §4.7: Projection 切换门槛 — 定义切换到 Projection 执行的六个必要条件。
 *
 * 所有条件必须同时满足才能启用 Projection 用于执行路由选择。
 * 任何条件不满足 → 保持 Authority 模式（Fail-safe）。
 *
 * 六个条件：
 * 1. 无未知事件积压 — ControlPlaneEventDelivery 无 UNSUPPORTED_EVENT 类型的 pending 行
 * 2. 全量 Projection 重建完成 — 所有已知 Route 均有 Projection 行
 * 3. 连续观察窗口无不可解释差异 — Shadow diff 在窗口内全 consistent
 * 4. 所有证据 ID 完整 — Projection 无 null 证据字段
 * 5. Binding 集成测试通过 — 外部确认
 * 6. 撤回与撤销传播测试通过 — 外部确认
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §4.7
 */

// ─── 门槛条件类型 ──────────────────────────────────────────

export interface ProjectionCutoverConditions {
  /** 1. 无未知事件积压。 */
  noUnknownEventBacklog: boolean;
  /** 未知事件积压数量（信息用）。 */
  unknownEventBacklogCount: number;

  /** 2. 全量 Projection 重建完成。 */
  allProjectionsRebuilt: boolean;
  /** 缺少 Projection 的 Route 数量。 */
  missingProjectionCount: number;

  /** 3. 连续观察窗口无不可解释差异。 */
  noUnexplainedDiffInWindow: boolean;
  /** 窗口内不一致次数。 */
  inconsistentCountInWindow: number;
  /** 观察窗口大小（小时）。 */
  observationWindowHours: number;

  /** 4. 所有证据 ID 完整。 */
  allEvidenceIdsComplete: boolean;
  /** 缺少证据 ID 的 Projection 数量。 */
  incompleteEvidenceCount: number;

  /** 5. Binding 集成测试通过。 */
  bindingIntegrationTestsPassed: boolean;

  /** 6. 撤回与撤销传播测试通过。 */
  withdrawalPropagationTestsPassed: boolean;
}

// ─── 切换判断结果 ──────────────────────────────────────────

export interface ProjectionCutoverReadiness {
  /** 是否可以切换到 Projection 执行。 */
  ready: boolean;
  /** 各条件详情。 */
  conditions: ProjectionCutoverConditions;
  /** 不满足的条件列表。 */
  failingConditions: string[];
}

// ─── 校验函数 ──────────────────────────────────────────────

/**
 * §4.7: 判断是否满足 Projection 切换门槛。
 *
 * 纯函数，无副作用。所有条件必须同时满足。
 */
export function canSwitchToProjectionExecution(
  conditions: ProjectionCutoverConditions,
): ProjectionCutoverReadiness {
  const failingConditions: string[] = [];

  if (!conditions.noUnknownEventBacklog) {
    failingConditions.push(
      `unknown_event_backlog: ${conditions.unknownEventBacklogCount} pending unsupported events`,
    );
  }

  if (!conditions.allProjectionsRebuilt) {
    failingConditions.push(
      `missing_projections: ${conditions.missingProjectionCount} routes without projection`,
    );
  }

  if (!conditions.noUnexplainedDiffInWindow) {
    failingConditions.push(
      `unexplained_diff: ${conditions.inconsistentCountInWindow} inconsistencies in ${conditions.observationWindowHours}h window`,
    );
  }

  if (!conditions.allEvidenceIdsComplete) {
    failingConditions.push(
      `incomplete_evidence: ${conditions.incompleteEvidenceCount} projections with null evidence IDs`,
    );
  }

  if (!conditions.bindingIntegrationTestsPassed) {
    failingConditions.push("binding_integration_tests_not_passed");
  }

  if (!conditions.withdrawalPropagationTestsPassed) {
    failingConditions.push("withdrawal_propagation_tests_not_passed");
  }

  return {
    ready: failingConditions.length === 0,
    conditions,
    failingConditions,
  };
}
