import { getThreadById, listDeploymentsByThread, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/deployments → 部署历史 + 状态 + CI/CD job 链接。
 *
 * V3.8 Stage E：Studio 部署观测入口。
 *
 * 权限同 delivery route：owner 或 thread.read.all；foreign → 404；未登录 → 401；
 * 无 studio.access → 403。无部署时返回空列表。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const deployments = await listDeploymentsByThread(id);

  return jsonOk({
    threadId: id,
    deployments: deployments.map((d) => ({
      id: d.id,
      environment: d.environment,
      commitSha: d.commitSha,
      imageTag: d.imageTag,
      cicdJobId: d.cicdJobId,
      cicdJobUrl: d.cicdJobUrl,
      status: d.status,
      previousDeploymentId: d.previousDeploymentId,
      deployedAt: d.deployedAt,
      rolledBackAt: d.rolledBackAt,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt,
    })),
  });
}
