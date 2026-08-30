import { describe, expect, it } from "vitest";
import { projectHostedProvisioningRequest } from "./hosted-provisioning-admin-projection";

/**
 * 专题01 冻结（runtime-only）：
 * DTO 只含 id/tenant_id/requester_id/route_scope_key + 状态/重试/时间 +
 * runtime/route checkpoint + workflow 版本/时间戳。
 * 不得出现 agent_id / agent_revision_id / desired_runtime_key 或 Agent checkpoint 字段。
 */
const RUNTIME_ONLY_STEPS = [
  "validate_request",
  "prepare_runtime_revision",
  "verify_runtime_artifact",
  "record_runtime_conformance",
  "publish_runtime_revision",
  "activate_route",
  "await_projection",
  "verify_route",
] as const;

function runtimeOnlyRow() {
  const createdAt = new Date("2026-08-10T23:59:00.000Z");
  const updatedAt = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "request-1",
    tenantId: "tenant-1",
    requesterId: "requester-1",
    routeScopeKey: "prod",
    state: "running",
    currentStep: "verify_runtime_artifact",
    attemptCount: 2,
    nextAttemptAt: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-11T00:05:00.000Z"),
    lastError: null,
    lastAttemptAt: new Date("2026-08-11T00:00:00.000Z"),
    createdAt,
    updatedAt,
    stepRuntimeId: "runtime-1",
    stepRuntimeRevisionId: "runtime-revision-1",
    stepRuntimeArtifactId: "artifact-runtime-1",
    stepRuntimeAttestationIds: ["attestation-runtime-1"],
    stepRuntimePublicationRecordId: null,
    stepConformanceRunId: null,
    stepRouteSetId: null,
    stepRouteSetVersionNo: null,
    stepRouteId: null,
    stepRouteRevisionId: null,
    stepRouteActivationId: null,
    stepProjectionVersionNo: null,
    workflowVersion: "3.0",
    lastCompletedStep: "prepare_runtime_revision",
  };
}

describe("hosted provisioning admin projection（runtime-only）", () => {
  it("投影完整 runtime-only DTO：requester_id 与 runtime/route checkpoint 精确落位", () => {
    const dto = projectHostedProvisioningRequest(runtimeOnlyRow() as never);

    // 身份/作用域
    expect(dto.id).toBe("request-1");
    expect(dto.tenant_id).toBe("tenant-1");
    expect(dto.requester_id).toBe("requester-1");
    expect(dto.route_scope_key).toBe("prod");

    // 状态/重试/时间
    expect(dto.state).toBe("running");
    expect(dto.current_step).toBe("verify_runtime_artifact");
    expect(dto.last_completed_step).toBe("prepare_runtime_revision");
    expect(dto.attempt_count).toBe(2);
    expect(dto.next_attempt_at).toBeNull();
    expect(dto.last_attempt_at).toBe("2026-08-11T00:00:00.000Z");
    expect(dto.lease_expires_at).toBe("2026-08-11T00:05:00.000Z");
    expect(dto.last_error).toBeNull();
    expect(dto.workflow_version).toBe("3.0");
    expect(dto.created_at).toBe("2026-08-10T23:59:00.000Z");
    expect(dto.updated_at).toBe("2026-08-11T00:00:00.000Z");

    // runtime checkpoint
    expect(dto.runtime_id).toBe("runtime-1");
    expect(dto.runtime_revision_id_checkpoint).toBe("runtime-revision-1");
    expect(dto.runtime_artifact_id).toBe("artifact-runtime-1");
    expect(dto.runtime_attestation_ids).toEqual(["attestation-runtime-1"]);
    expect(dto.conformance_run_id).toBeNull();
    expect(dto.runtime_publication_record_id).toBeNull();

    // route checkpoint
    expect(dto.route_set_id).toBeNull();
    expect(dto.route_set_version_no).toBeNull();
    expect(dto.route_id).toBeNull();
    expect(dto.route_revision_id).toBeNull();
    expect(dto.route_activation_id).toBeNull();
    expect(dto.projection_version_no).toBeNull();
  });

  it("DTO 不得包含任何 Agent 或可选 Runtime key 字段（强 absence 断言）", () => {
    const dto = projectHostedProvisioningRequest(runtimeOnlyRow() as never) as unknown as Record<
      string,
      unknown
    >;

    expect(dto).not.toHaveProperty("agent_id");
    expect(dto).not.toHaveProperty("agent_revision_id");
    expect(dto).not.toHaveProperty("desired_runtime_key");
    expect(dto).not.toHaveProperty("agent_revision_id_checkpoint");
    expect(dto).not.toHaveProperty("agent_publication_record_id");
  });

  it("步骤序列恰为 8 个 runtime-only 步骤，不含 ensure_agent_publication", () => {
    // 每一步都必须是合法 runtime-only 步骤。
    const dto = projectHostedProvisioningRequest(runtimeOnlyRow() as never);
    for (const step of [dto.current_step, dto.last_completed_step]) {
      if (step !== null) {
        expect(RUNTIME_ONLY_STEPS).toContain(step);
      }
    }
    // 旧 Agent 步骤不在 8 步序列内。
    expect(RUNTIME_ONLY_STEPS).toHaveLength(8);
    expect(RUNTIME_ONLY_STEPS).not.toContain("ensure_agent_publication");
  });

  it("DTO 字段白名单：不含任何额外 Agent/runtime-key 字段", () => {
    const dto = projectHostedProvisioningRequest(runtimeOnlyRow() as never) as unknown as Record<
      string,
      unknown
    >;
    const ALLOWED = new Set<string>([
      "id",
      "tenant_id",
      "requester_id",
      "route_scope_key",
      "state",
      "current_step",
      "last_completed_step",
      "attempt_count",
      "next_attempt_at",
      "last_attempt_at",
      "lease_expires_at",
      "last_error",
      "runtime_id",
      "runtime_revision_id_checkpoint",
      "runtime_artifact_id",
      "runtime_attestation_ids",
      "conformance_run_id",
      "runtime_publication_record_id",
      "route_set_id",
      "route_set_version_no",
      "route_id",
      "route_revision_id",
      "route_activation_id",
      "projection_version_no",
      "workflow_version",
      "created_at",
      "updated_at",
    ]);
    for (const key of Object.keys(dto)) {
      expect(ALLOWED.has(key)).toBe(true);
    }
  });
});
