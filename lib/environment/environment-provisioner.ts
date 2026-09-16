import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";
import {
  EnvironmentComplianceError,
  createEnvironmentLease,
  prepareEnvironmentLease,
  releaseEnvironmentLease,
} from "./environment-lease-store";

export interface EnvironmentProvisioner {
  provision(input: {
    tenantId: string;
    invocationId: string;
    attemptId: string;
    revision: EnvironmentDefinitionRevision;
    workspaceBindingId: string;
  }): Promise<EnvironmentLease>;
  /** Re-check a suspended instance before a fresh Ownership generation may use it. */
  revalidate(input: {
    tenantId: string;
    lease: EnvironmentLease;
    revision: EnvironmentDefinitionRevision;
    workspaceBindingId: string;
  }): Promise<EnvironmentLease>;
}

/** Managed adapter boundary. It returns evidence only after compliance is verified. */
export function createManagedEnvironmentProvisioner(dependencies: {
  discoverCapabilities: (
    revision: EnvironmentDefinitionRevision,
  ) => Promise<{ capabilities: unknown; evidence: unknown }>;
}): EnvironmentProvisioner {
  const verify = async (input: {
    tenantId: string;
    lease: EnvironmentLease;
    revision: EnvironmentDefinitionRevision;
  }) => {
    if (input.lease.environmentDefinitionRevisionId !== input.revision.id) {
      throw new EnvironmentComplianceError("EnvironmentLease 与冻结 Revision 不匹配");
    }
    const discovered = await dependencies.discoverCapabilities(input.revision);
    return prepareEnvironmentLease({
      tenantId: input.tenantId,
      leaseId: input.lease.id,
      capabilitiesJson: discovered.capabilities,
      evidence: discovered.evidence,
    });
  };
  return {
    async provision(input) {
      const lease = await createEnvironmentLease({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        environmentDefinitionRevisionId: input.revision.id,
        resourceManifest: {
          workspaceBindingId: input.workspaceBindingId,
          revisionId: input.revision.id,
        },
      });
      try {
        return await verify({ tenantId: input.tenantId, lease, revision: input.revision });
      } catch (error) {
        await releaseEnvironmentLease(input.tenantId, lease.id, "lost").catch(() => undefined);
        throw new EnvironmentComplianceError(
          error instanceof Error ? error.message : "Environment compliance failed",
        );
      }
    },
    async revalidate(input) {
      if (input.lease.readinessState !== "preparing" || input.lease.leaseState !== "active") {
        throw new EnvironmentComplianceError("EnvironmentLease 不是可恢复的受管实例");
      }
      try {
        return await verify(input);
      } catch (error) {
        await releaseEnvironmentLease(input.tenantId, input.lease.id, "lost").catch(
          () => undefined,
        );
        throw new EnvironmentComplianceError(
          error instanceof Error ? error.message : "Environment compliance failed",
        );
      }
    },
  };
}
