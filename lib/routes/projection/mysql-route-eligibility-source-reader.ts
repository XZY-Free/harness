/**
 * MySQL RouteEligibilitySourceReader 实现。
 *
 * §05.1/§05.2: 只读权威事实表来定位受影响 Route，绝不查询 Projection。
 * DeploymentRoute 无 tenantId 列，需通过 JOIN DeploymentRouteSet 获取。
 */

import { db } from "@/lib/db/client";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import { routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { eq, inArray, sql } from "drizzle-orm";
import type {
  RouteEligibilitySourceReader,
  RouteSourceRef,
} from "./route-eligibility-source-reader";

/** 公共 SELECT：routeId + tenantId（通过 JOIN RouteSet 获取 tenantId）。 */
const routeSourceRefSelect = {
  routeId: deploymentRouteTable.id,
  tenantId: deploymentRouteSetTable.tenantId,
} as const;

export function createMySqlRouteEligibilitySourceReader(
  _deps: { db: typeof db },
): RouteEligibilitySourceReader {
  return {
    async listRouteIdsByRouteSet(routeSetId: string): Promise<RouteSourceRef[]> {
      // 权威：DeploymentRoute where routeSetId, JOIN RouteSet for tenantId
      return db
        .select(routeSourceRefSelect)
        .from(deploymentRouteTable)
        .innerJoin(
          deploymentRouteSetTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(eq(deploymentRouteTable.routeSetId, routeSetId));
    },

    async listRouteIdsByAgentRevision(agentRevisionId: string): Promise<RouteSourceRef[]> {
      // 权威：RouteRevision.agentRevisionId → DeploymentRoute → RouteSet
      return db
        .select(routeSourceRefSelect)
        .from(routeRevision)
        .innerJoin(
          deploymentRouteTable,
          eq(deploymentRouteTable.activeRouteRevisionId, routeRevision.id),
        )
        .innerJoin(
          deploymentRouteSetTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(eq(routeRevision.agentRevisionId, agentRevisionId));
    },

    async listRouteIdsByRuntimeRevision(runtimeRevisionId: string): Promise<RouteSourceRef[]> {
      // 权威：RouteRevision.runtimeRevisionId → DeploymentRoute → RouteSet
      return db
        .select(routeSourceRefSelect)
        .from(routeRevision)
        .innerJoin(
          deploymentRouteTable,
          eq(deploymentRouteTable.activeRouteRevisionId, routeRevision.id),
        )
        .innerJoin(
          deploymentRouteSetTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(eq(routeRevision.runtimeRevisionId, runtimeRevisionId));
    },

    async listRouteIdsByAgent(agentId: string): Promise<RouteSourceRef[]> {
      // 权威：DeploymentRouteSet.agentId → DeploymentRoute
      return db
        .select(routeSourceRefSelect)
        .from(deploymentRouteSetTable)
        .innerJoin(
          deploymentRouteTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(eq(deploymentRouteSetTable.agentId, agentId));
    },

    async listRouteIdsByRuntime(runtimeId: string): Promise<RouteSourceRef[]> {
      // 权威：RuntimeRevision.runtimeId → RouteRevision.runtimeRevisionId → DeploymentRoute → RouteSet
      const revisions = await db
        .select({ id: runtimeRevisionTable.id })
        .from(runtimeRevisionTable)
        .where(eq(runtimeRevisionTable.runtimeId, runtimeId));
      if (revisions.length === 0) return [];
      const revisionIds = revisions.map((r) => r.id);
      return db
        .select(routeSourceRefSelect)
        .from(routeRevision)
        .innerJoin(
          deploymentRouteTable,
          eq(deploymentRouteTable.activeRouteRevisionId, routeRevision.id),
        )
        .innerJoin(
          deploymentRouteSetTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(inArray(routeRevision.runtimeRevisionId, revisionIds));
    },

    async listRouteIdsByPolicyRevision(policyRevisionId: string): Promise<RouteSourceRef[]> {
      // 权威：RouteRevision.policyRevisionId → DeploymentRoute → RouteSet
      return db
        .select(routeSourceRefSelect)
        .from(routeRevision)
        .innerJoin(
          deploymentRouteTable,
          eq(deploymentRouteTable.activeRouteRevisionId, routeRevision.id),
        )
        .innerJoin(
          deploymentRouteSetTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(eq(routeRevision.policyRevisionId, policyRevisionId));
    },

    async listRouteIdsByAttestation(attestationId: string): Promise<RouteSourceRef[]> {
      // 权威路径：
      // attestationId → PublicationRecord where JSON_CONTAINS(attestationIds, attestationId)
      // → subjectRevisionId (agentRevisionId or runtimeRevisionId)
      // → RouteRevision → DeploymentRoute → RouteSet
      const pubs = await db
        .select({
          subjectRevisionId: publicationRecord.subjectRevisionId,
          subjectType: publicationRecord.subjectType,
        })
        .from(publicationRecord)
        .where(
          sql`JSON_CONTAINS(${publicationRecord.attestationIds}, ${JSON.stringify(attestationId)})`,
        );
      if (pubs.length === 0) return [];

      const agentRevisionIds = pubs
        .filter((p) => p.subjectType === "agent_revision")
        .map((p) => p.subjectRevisionId);
      const runtimeRevisionIds = pubs
        .filter((p) => p.subjectType === "runtime_revision")
        .map((p) => p.subjectRevisionId);

      const results: RouteSourceRef[] = [];

      if (agentRevisionIds.length > 0) {
        const agentRows = await db
          .select(routeSourceRefSelect)
          .from(routeRevision)
          .innerJoin(
            deploymentRouteTable,
            eq(deploymentRouteTable.activeRouteRevisionId, routeRevision.id),
          )
          .innerJoin(
            deploymentRouteSetTable,
            eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
          )
          .where(inArray(routeRevision.agentRevisionId, agentRevisionIds));
        results.push(...agentRows);
      }

      if (runtimeRevisionIds.length > 0) {
        const runtimeRows = await db
          .select(routeSourceRefSelect)
          .from(routeRevision)
          .innerJoin(
            deploymentRouteTable,
            eq(deploymentRouteTable.activeRouteRevisionId, routeRevision.id),
          )
          .innerJoin(
            deploymentRouteSetTable,
            eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
          )
          .where(inArray(routeRevision.runtimeRevisionId, runtimeRevisionIds));
        results.push(...runtimeRows);
      }

      // 去重（同一 routeId 可能通过 agent 和 runtime 两条路径命中）
      const seen = new Set<string>();
      return results.filter((r) => {
        if (seen.has(r.routeId)) return false;
        seen.add(r.routeId);
        return true;
      });
    },

    async listAllCurrentlyActivatedRouteIds(): Promise<RouteSourceRef[]> {
      // 权威：DeploymentRoute where routeState = 'enabled', JOIN RouteSet for tenantId
      return db
        .select(routeSourceRefSelect)
        .from(deploymentRouteTable)
        .innerJoin(
          deploymentRouteSetTable,
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
        )
        .where(eq(deploymentRouteTable.routeState, "enabled"));
    },
  };
}

/** 单例 — 默认使用全局 db。 */
export const mysqlRouteEligibilitySourceReader = createMySqlRouteEligibilitySourceReader({ db });
