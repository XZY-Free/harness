import { db } from "@/lib/db/client";
import { jsonError, jsonOk } from "@/lib/http";
import { checkActionScope } from "@/lib/identity/authorization";
import {
  PermissionManagementError,
  changePermissionManagement,
} from "@/lib/identity/permission-management";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { agentTable } from "@/lib/persistence/schema/agents";
import { permissionGroup, resourceAccessPolicy } from "@/lib/persistence/schema/authorization";
import { principalBinding } from "@/lib/persistence/schema/identity";
import { and, eq, or } from "drizzle-orm";
import type { NextRequest } from "next/server";

type Context = { params: Promise<{ agent_id: string }> };
async function authorize(request: NextRequest, context: Context) {
  const gate = await requireStudioAction(request, "studio.access");
  if (!gate.ok) return gate;
  const { agent_id: id } = await context.params;
  const [agent] = await db
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, gate.principal.tenantId), eq(agentTable.id, id)));
  if (!agent || agent.deletedAt)
    return { ok: false as const, response: jsonError(404, "not_found", "智能体不存在") };
  const manages = await checkActionScope(gate.principal.tenantId, gate.principal.userIdentityId, {
    actionCode: "user.manage",
    resource: { type: "tenant", id: gate.principal.tenantId },
  });
  if (agent.ownerUserId !== gate.principal.userIdentityId && !manages.allowed)
    return {
      ok: false as const,
      response: jsonError(403, "permission_denied", "没有管理此智能体使用范围的权限"),
    };
  return { ...gate, agent };
}
export async function GET(request: NextRequest, context: Context) {
  const gate = await authorize(request, context);
  if (!gate.ok) return gate.response;
  const tenantId = gate.principal.tenantId;
  const [policies, principals, groups] = await Promise.all([
    db
      .select()
      .from(resourceAccessPolicy)
      .where(
        and(
          eq(resourceAccessPolicy.tenantId, tenantId),
          or(
            and(
              eq(resourceAccessPolicy.resourceType, "agent"),
              eq(resourceAccessPolicy.resourceId, gate.agent.id),
            ),
            and(
              eq(resourceAccessPolicy.resourceType, "tenant"),
              eq(resourceAccessPolicy.resourceId, tenantId),
            ),
          ),
        ),
      ),
    db
      .select({
        id: principalBinding.id,
        label: principalBinding.displayName,
        type: principalBinding.subjectType,
      })
      .from(principalBinding)
      .where(eq(principalBinding.tenantId, tenantId)),
    db.select().from(permissionGroup).where(eq(permissionGroup.tenantId, tenantId)),
  ]);
  return jsonOk({
    defaultMode: policies.find((p) => p.resourceType === "tenant")?.mode ?? "all",
    policy: policies.find((p) => p.resourceType === "agent") ?? {
      mode: "restricted",
      principals: [],
      collaborators: [],
      version: 0,
    },
    subjects: principals
      .filter((p) => p.type === "user" || groups.some((g) => g.principalId === p.id))
      .map((p) => ({
        id: p.id,
        label: p.label ?? "未命名成员",
        description:
          p.type === "user"
            ? "成员"
            : groups.find((g) => g.principalId === p.id)?.source === "local"
              ? "本地用户组"
              : "企业组织",
      })),
  });
}
export async function PUT(request: NextRequest, context: Context) {
  const gate = await authorize(request, context);
  if (!gate.ok) return gate.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError(400, "invalid_input", "请求格式无效");
  try {
    return jsonOk(
      await changePermissionManagement(gate.principal.tenantId, gate.principal.userIdentityId, {
        ...body,
        operation: "save_access",
        resourceType: "agent",
        resourceId: gate.agent.id,
      }),
    );
  } catch (error) {
    if (error instanceof PermissionManagementError)
      return jsonError(error.status, error.code, error.message);
    return jsonError(500, "update_failed", "使用范围保存失败");
  }
}
