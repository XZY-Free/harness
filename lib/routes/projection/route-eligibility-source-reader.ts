/**
 * RouteEligibilitySourceReader — 从权威事实表发现受影响的 Route。
 *
 * /: 与 RouteEligibilityStore（只做 Projection CRUD）分离，
 * SourceReader 只读取权威事实表来定位 Route，绝不查询 Projection。
 *
 * 权威事实表：DeploymentRoute, RouteRevision, RouteActivation,
 * AgentRevision, RuntimeRevision, PublicationRecord,
 * ArtifactAttestation, Policy。
 *
 * Projection 不存在时也能发现 Route — 这是首次构建的前提。
 */

/** SourceReader 返回的最小 Route 定位信息。 */
export interface RouteSourceRef {
  routeId: string;
  tenantId: string;
}

export interface RouteEligibilitySourceReader {
  /** 按 RouteSet 查询所有 Route ID。 */
  listRouteIdsByRouteSet(routeSetId: string): Promise<RouteSourceRef[]>;

  /** 按 AgentRevision 查询引用该 Revision 的所有 Route。 */
  listRouteIdsByAgentRevision(agentRevisionId: string): Promise<RouteSourceRef[]>;

  /** 按 RuntimeRevision 查询引用该 Revision 的所有 Route。 */
  listRouteIdsByRuntimeRevision(runtimeRevisionId: string): Promise<RouteSourceRef[]>;

  /** 按 Agent 查询该 Agent 下所有当前 Route。 */
  listRouteIdsByAgent(agentId: string): Promise<RouteSourceRef[]>;

  /** 按 Runtime 查询引用该 Runtime 的所有当前 Route。 */
  listRouteIdsByRuntime(runtimeId: string): Promise<RouteSourceRef[]>;

  /** 按 PolicyRevision 查询引用该 Policy 的所有 Route。 */
  listRouteIdsByPolicyRevision(policyRevisionId: string): Promise<RouteSourceRef[]>;

  /**
   * 按 Attestation ID 查询引用该 Attestation 的所有 Route。
   *
   * 路径：Attestation → PublicationRecord.attestationIds → subjectRevisionId
   * → RouteRevision.agentRevisionId / runtimeRevisionId → DeploymentRoute
   */
  listRouteIdsByAttestation(attestationId: string): Promise<RouteSourceRef[]>;

  /** 查询所有存在 latest RouteActivation 的 Route，包含 disabled。 */
  listAllCurrentlyActivatedRouteIds(): Promise<RouteSourceRef[]>;
}
