import { evaluateSnapshot } from "@/lib/identity-client/evaluate";
import type { PermissionSnapshot } from "@/lib/identity-client/snapshot";
/**
 * 统一管理后台导航可见性解析（S11-W01）。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 * S11-W01：「菜单可见性与服务端 Action Scope 同源；隐藏菜单不能代替授权校验」
 * 「后台信息架构」8 个一级导航：智能体 / 能力与知识 / 会话与协作 / Runtime 与环境 /
 * 观测与评测 / 安全与审计 / 运营 / 平台设置
 *
 * 消费方模型 v4：可见性由**权限快照**（auth-center 预展开清单）本地投影——
 * `navVisibilityFromSnapshot` 为纯函数（/studio/api/context 接口消费）。
 *
 * 安全边界：
 * - 菜单可见性只是 UX 层，不能代替服务端 Action Scope 校验（每个写 API 仍走 requireActionScope）。
 * - 解析失败 fail-closed：异常时所有菜单隐藏（避免误暴露）。
 */
import type { ActionCode } from "@/lib/identity/action-codes";

/** 8 个一级菜单 ID（与 nav.tsx ITEMS 顺序一致）。 */
export const STUDIO_NAV_IDS = [
  "agents",
  "capabilities",
  "conversations",
  "runtime",
  "observability",
  "security",
  "operations",
  "settings",
] as const;

export type StudioNavId = (typeof STUDIO_NAV_IDS)[number];

/** 8 个一级菜单 → 关联的 ActionCode（任意匹配即可见）。 */
export const NAV_ACTION_MAPPING: Record<StudioNavId, readonly ActionCode[]> = {
  // 智能体：Agent / Revision / Route / 发布
  agents: [
    "agent.read",
    "agent.contract.register",
    "agent.revision.create",
    "agent.publish",
    "route.update",
  ],
  // 能力与知识：Skill / Tool / Knowledge / Connection / 风险变化
  capabilities: [
    "skill.create",
    "tool.create",
    "tool.schema.publish",
    "tool.provider.create",
    "connection.create",
    "knowledge.base.create",
    "knowledge.document.create",
    "capability.review",
  ],
  // 会话与协作：Thread / Turn / Job 排障（取消 / 重试 / 隔离）
  conversations: ["job.cancel", "job.retry", "memory.review", "event.quarantine.resolve"],
  // Runtime 与环境：RuntimeRevision / Environment / Desktop
  runtime: ["runtime.publish"],
  // 观测与评测：Trace / Evaluation / ArtifactAttestation
  observability: ["artifact.attestation.verify", "event.quarantine.resolve"],
  // 安全与审计：Policy / Credential / Legal Hold / Deletion / Audit 导出
  security: [
    "audit.read",
    "policy.publish",
    "credential.bind",
    "credential.revoke",
    "legal_hold.manage",
    "deletion.request",
    "audit.export",
  ],
  // 运营：成本 / 容量 / 配额（暂未定义专门 action code，归并到 audit.export）
  operations: ["admin.operations.read", "audit.export"],
  // 平台设置：用户 / 角色 / 组织配置，与设置页 user.manage 门禁保持一致
  settings: ["user.manage"],
};

/** 菜单可见性结果：8 个 bool。 */
export interface StudioNavVisibility {
  readonly agents: boolean;
  readonly capabilities: boolean;
  readonly conversations: boolean;
  readonly runtime: boolean;
  readonly observability: boolean;
  readonly security: boolean;
  readonly operations: boolean;
  readonly settings: boolean;
}

const ALL_HIDDEN: StudioNavVisibility = {
  agents: false,
  capabilities: false,
  conversations: false,
  runtime: false,
  observability: false,
  security: false,
  operations: false,
  settings: false,
};

/**
 * 由权限快照投影 8 个一级菜单可见性（纯函数，不做 IO）。
 *
 * 流程：先检查真实 studio.access（快照本地匹配），再按有效授权计算菜单；
 * 快照 inactive / 无绑定 / 异常时全部隐藏（fail-closed）。
 */
export function navVisibilityFromSnapshot(snapshot: PermissionSnapshot): StudioNavVisibility {
  try {
    if (
      !evaluateSnapshot(snapshot, {
        actionCode: "studio.access",
        resource: { type: "tenant", id: snapshot.tenantId },
      }).allowed
    ) {
      return ALL_HIDDEN;
    }
    const allowedActions: ReadonlySet<string> = new Set(snapshot.grants.map((g) => g.actionCode));

    // 没有任何 action 绑定 → 全部隐藏（fail-closed）
    if (allowedActions.size === 0) {
      return ALL_HIDDEN;
    }

    const result: Record<StudioNavId, boolean> = {
      agents: false,
      capabilities: false,
      conversations: false,
      runtime: false,
      observability: false,
      security: false,
      operations: false,
      settings: false,
    };
    for (const id of STUDIO_NAV_IDS) {
      const requiredActions = NAV_ACTION_MAPPING[id];
      result[id] = requiredActions.some((action) => allowedActions.has(action));
    }
    return result;
  } catch {
    // 投影失败 fail-closed，所有菜单隐藏
    return ALL_HIDDEN;
  }
}
