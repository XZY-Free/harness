/**
 * V11 统一管理后台导航可见性解析（S11-W01）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 * S11-W01：「菜单可见性与服务端 Action Scope 同源；隐藏菜单不能代替授权校验」
 * 「后台信息架构」8 个一级导航：智能体 / 能力与知识 / 会话与协作 / Runtime 与环境 /
 * 观测与评测 / 安全与审计 / 运营 / 平台设置
 *
 * 职责：
 * - 给定 Principal，批量查询其 role_action_binding，按 8 个一级菜单的 action 集合
 * 计算可见性。
 * - 任何一个关联 action 允许 → 该菜单可见（"任意匹配"语义）。
 * - 部分菜单（运营 / 平台设置）暂未在 ACTION_CODES 中定义专门写操作，
 * 采用"主体拥有任意管理 action"作为可见条件（admin 默认全部可见）。
 *
 * 安全边界：
 * - 菜单可见性只是 UX 层，不能代替服务端 Action Scope 校验（每个写 API 仍走 requireActionScope）。
 * - dev/test 模式下 devOpen + DEFAULT_USER_ID 直接给全部权限，菜单全部可见（与 lib/rbac 一致）。
 * - 解析失败 fail-closed：异常时所有菜单隐藏（避免误暴露）。
 *
 * 使用：
 * ```ts
 * const visibility = await computeStudioNavVisibility(principal);
 * if (visibility.agents) <Link href="/studio/agents">智能体</Link>
 * ```
 */
import { authConfig } from "@/lib/config";
import { DEFAULT_USER_ID } from "@/lib/constants";
import { ACTION_CODES, type ActionCode } from "@/lib/identity/action-codes";
import type { Principal } from "@/lib/identity/resolver";
import { listActiveActionBindingsForUser } from "@/lib/identity/role-action-queries";

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
 agents: ["agent.revision.create", "agent.publish", "route.update"],
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
 "policy.publish",
 "credential.bind",
 "credential.revoke",
 "legal_hold.manage",
 "deletion.request",
 "audit.export",
 ],
 // 运营：成本 / 容量 / 配额（暂未定义专门 action code，归并到 audit.export）
 operations: ["audit.export"],
 // 平台设置：组织 / 模型供应方 / 保留策略（暂未定义专门 action code，归并到 policy.publish）
 settings: ["policy.publish"],
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

const ALL_VISIBLE: StudioNavVisibility = {
 agents: true,
 capabilities: true,
 conversations: true,
 runtime: true,
 observability: true,
 security: true,
 operations: true,
 settings: true,
};

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
 * 计算 8 个一级菜单的可见性。
 *
 * 流程：
 * 1. dev/test + DEFAULT_USER_ID → 全部可见（与 lib/rbac devOpen 一致）。
 * 2. 否则查 listActiveActionBindingsForUser → 收集允许的 actionCode 集合。
 * 3. 对每个菜单，NAV_ACTION_MAPPING[id] 与允许集合有交集 → 可见。
 * 4. 任何异常 → 全部隐藏（fail-closed）。
 */
export async function computeStudioNavVisibility(
 principal: Principal,
): Promise<StudioNavVisibility> {
 // dev 模式 + 默认用户 → 全部可见（与 lib/rbac devOpen 行为一致）
 if (authConfig.mode === "dev" && principal.externalSubject === DEFAULT_USER_ID) {
 return ALL_VISIBLE;
 }

 try {
 const bindings = await listActiveActionBindingsForUser(
 principal.tenantId,
 principal.userIdentityId,
 );
 const allowedActions: ReadonlySet<string> = new Set(bindings.map((b) => b.actionCode));

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
 // 查询失败 fail-closed，所有菜单隐藏
 return ALL_HIDDEN;
 }
}

/**
 * 检查单个菜单项是否可见（用于子页 / API 校验时复用）。
 *
 * 注意：此函数只查可见性，不替代服务端 Action Scope 校验。
 * 写操作仍需调用 requireActionScope。
 */
export async function isNavVisible(principal: Principal, navId: StudioNavId): Promise<boolean> {
 const visibility = await computeStudioNavVisibility(principal);
 return visibility[navId];
}

/** 调试用：返回所有合法 ActionCode（仅供测试与文档）。 */
export function getAllKnownActionCodes(): readonly ActionCode[] {
 return ACTION_CODES;
}
