export interface HostedRuntimeRoute {
  routeId: string;
  routeRevisionId: string;
  routeActivationId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
}

export interface PublishedHostedAgentRevision {
  revisionId: string;
  publicationRecordId: string;
  attestationId: string;
}

export interface PublishedHostedRuntimeRevision {
  revisionId: string;
  publicationRecordId: string;
  attestationId: string;
  conformanceRunId: string;
}

export interface HostedRuntimeControlPlane {
  /** 只返回已经通过正式 Resolver 全部门禁的路由。 */
  resolveEligibleRoute(command: {
    tenantId: string;
    agentId: string;
    routeScopeKey: string;
  }): Promise<HostedRuntimeRoute | null>;
  ensurePublishedAgentRevision(command: {
    tenantId: string;
    agentId: string;
  }): Promise<PublishedHostedAgentRevision>;
  ensurePublishedRuntimeRevision(command: {
    tenantId: string;
    agentId: string;
  }): Promise<PublishedHostedRuntimeRevision>;
  activateRoute(command: {
    tenantId: string;
    agentId: string;
    routeScopeKey: string;
    agentRevision: PublishedHostedAgentRevision;
    runtimeRevision: PublishedHostedRuntimeRevision;
  }): Promise<void>;
}

export interface ProvisionHostedRuntimeCommand {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
}

export class HostedRuntimeProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedRuntimeProvisioningError";
  }
}

export function createProvisionHostedRuntime(dependencies: {
  controlPlane: HostedRuntimeControlPlane;
}) {
  return async function provisionHostedRuntime(
    command: ProvisionHostedRuntimeCommand,
  ): Promise<HostedRuntimeRoute> {
    const existing = await dependencies.controlPlane.resolveEligibleRoute(command);
    if (existing) return existing;

    const agentRevision = await dependencies.controlPlane.ensurePublishedAgentRevision({
      tenantId: command.tenantId,
      agentId: command.agentId,
    });
    const runtimeRevision = await dependencies.controlPlane.ensurePublishedRuntimeRevision({
      tenantId: command.tenantId,
      agentId: command.agentId,
    });
    assertPublicationEvidence(agentRevision, "AgentRevision");
    assertPublicationEvidence(runtimeRevision, "RuntimeRevision");
    if (!runtimeRevision.conformanceRunId) {
      throw new HostedRuntimeProvisioningError("Hosted Runtime 缺少可信 Conformance Run");
    }

    await dependencies.controlPlane.activateRoute({
      tenantId: command.tenantId,
      agentId: command.agentId,
      routeScopeKey: command.routeScopeKey,
      agentRevision,
      runtimeRevision,
    });

    const resolved = await dependencies.controlPlane.resolveEligibleRoute(command);
    if (!resolved) {
      throw new HostedRuntimeProvisioningError("Hosted Route 激活后未通过正式 RouteResolver 门禁");
    }
    if (resolved.agentRevisionId !== agentRevision.revisionId) {
      throw new HostedRuntimeProvisioningError("Hosted Route 的 AgentRevision 不一致");
    }
    if (resolved.runtimeRevisionId !== runtimeRevision.revisionId) {
      throw new HostedRuntimeProvisioningError("Hosted Route 的 RuntimeRevision 不一致");
    }
    return resolved;
  };
}

function assertPublicationEvidence(
  revision: {
    revisionId: string;
    publicationRecordId: string;
    attestationId: string;
  },
  subject: string,
): void {
  if (!revision.revisionId || !revision.publicationRecordId || !revision.attestationId) {
    throw new HostedRuntimeProvisioningError(
      `${subject} 缺少正式 PublicationRecord 或 ArtifactAttestation`,
    );
  }
}
