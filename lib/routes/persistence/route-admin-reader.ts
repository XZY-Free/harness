import { db } from "@/lib/db/client";
import type { DeploymentRouteRow } from "@/lib/persistence/schema/routes";
import type { AdminRouteProjectionInput } from "@/lib/routes/application/route-admin-projection";
import {
  routeActivation,
  routeRevision,
  routeRevisionTargetFromRecord,
} from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, desc, eq } from "drizzle-orm";

export async function readAdminRoute(
  tenantId: string,
  route: DeploymentRouteRow,
): Promise<AdminRouteProjectionInput> {
  const [activation] = await db
    .select()
    .from(routeActivation)
    .where(
      and(
        eq(routeActivation.tenantId, tenantId),
        eq(routeActivation.routeId, route.id),
        eq(routeActivation.routeSetId, route.routeSetId),
      ),
    )
    .orderBy(desc(routeActivation.activationSequence))
    .limit(1);

  if (!activation) return { route, activation: null, revision: null, projection: null };

  const [revision] = await db
    .select()
    .from(routeRevision)
    .where(
      and(
        eq(routeRevision.id, activation.routeRevisionId),
        eq(routeRevision.tenantId, tenantId),
        eq(routeRevision.routeId, route.id),
        eq(routeRevision.routeSetId, route.routeSetId),
      ),
    )
    .limit(1);
  if (!revision) return { route, activation, revision: null, projection: null };

  // 从 DB 记录严格构造判别 target；畸形（混合/缺字段/占位）fail-closed → 视为无 Authority。
  const target = routeRevisionTargetFromRecord(revision);
  if (!target) return { route, activation, revision: null, projection: null };

  const [projection] = await db
    .select()
    .from(routeEligibilityProjection)
    .where(
      and(
        eq(routeEligibilityProjection.tenantId, tenantId),
        eq(routeEligibilityProjection.routeId, route.id),
        eq(routeEligibilityProjection.routeRevisionId, revision.id),
        eq(routeEligibilityProjection.routeActivationId, activation.id),
      ),
    )
    .limit(1);

  return {
    route,
    activation,
    revision: {
      id: revision.id,
      routeGroupId: revision.routeGroupId,
      target,
      policyRevisionId: revision.policyRevisionId,
      trafficWeight: revision.trafficWeight,
      priorityNo: revision.priorityNo,
      effectiveFrom: revision.effectiveFrom,
      effectiveUntil: revision.effectiveUntil,
      contentDigest: revision.contentDigest,
    },
    projection: projection ?? null,
  };
}
