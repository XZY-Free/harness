/**
 * ControlPlaneCutoverPlan — 控制面资格切换计划聚合根。
 *
 * 第二批核心领域对象。对历史 Active Route 引用的 AgentRevision / RuntimeRevision
 * 进行资格扫描，通过 Replacement Revision 重新认证后，一次原子切换 RouteSet。
 *
 * 冻结语义：
 * - 不修改历史 PublicationRecord（publishedBy=migration-0112, attestationIds=[]）
 * - 通过替代 Revision 完成重新认证
 * - 不得原地补证据
 */

/** CutoverPlan 状态机。 */
export const CUTOVER_PLAN_STATES = [
  "draft",
  "inventory_complete",
  "requalifying",
  "ready_to_activate",
  "activated",
  "failed",
  "cancelled",
] as const;
export type CutoverPlanState = (typeof CUTOVER_PLAN_STATES)[number];

/** CutoverPlan 聚合根。 */
export interface ControlPlaneCutoverPlan {
  id: string;
  tenantId: string;
  routeSetId: string;
  sourceRouteSetVersionNo: number;
  targetRouteSetVersionNo: number | null;
  state: CutoverPlanState;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
}

/** CutoverPlan 状态转换规则。 */
export function isValidPlanTransition(
  from: CutoverPlanState,
  to: CutoverPlanState,
): boolean {
  const ALLOWED: Record<CutoverPlanState, CutoverPlanState[]> = {
    draft: ["inventory_complete", "cancelled"],
    inventory_complete: ["requalifying", "cancelled"],
    requalifying: ["ready_to_activate", "failed", "cancelled"],
    ready_to_activate: ["activated", "failed", "cancelled"],
    activated: [],
    failed: [],
    cancelled: [],
  };
  return ALLOWED[from].includes(to);
}

export class CutoverPlanStateError extends Error {
  constructor(
    public readonly planId: string,
    public readonly fromState: CutoverPlanState,
    public readonly toState: CutoverPlanState,
  ) {
    super(`CutoverPlan ${planId} 不允许从 ${fromState} 转换到 ${toState}`);
    this.name = "CutoverPlanStateError";
  }
}

export class CutoverPlanNotFoundError extends Error {
  constructor(public readonly planId: string) {
    super(`CutoverPlan 不存在: ${planId}`);
    this.name = "CutoverPlanNotFoundError";
  }
}
