import { describe, expect, it } from "vitest";
import { projectAdminRoute, projectAdminRouteSet } from "./route-admin-projection";

/** agent RouteRevision target（domain 判别联合）— 只含所选 target 自己的事实。 */
const agentRevisionTarget = {
  kind: "agent",
  agentRevisionId: "agent-revision-1",
  agentEndpointRef: "https://agent.example.com/a2a",
  agentIdentityMode: "bearer",
  agentCredentialRefId: "cred-1",
  agentNetworkZone: "private",
} as const;

/** agent RouteRevision target 的 wire 投影 — 不携带 runtime 字段。 */
const agentRevisionTargetWire = {
  kind: "agent",
  agent_revision_id: "agent-revision-1",
  endpoint_ref: "https://agent.example.com/a2a",
  identity_mode: "bearer",
  credential_ref_id: "cred-1",
  network_zone: "private",
} as const;

describe("route admin projection", () => {
  it("只从 latest Activation 指向的 Revision 投影当前路由（agent target）", () => {
    expect(
      projectAdminRoute({
        route: {
          id: "route-1",
          routeSetId: "set-1",
          routeKey: "primary",
          routeState: "enabled",
          updatedAt: new Date("2026-08-11T00:00:00.000Z"),
        },
        activation: {
          id: "activation-2",
          routeRevisionId: "revision-2",
          activationSequence: 2,
          activationState: "active",
          activatedAt: new Date("2026-08-11T00:01:00.000Z"),
        },
        revision: {
          id: "revision-2",
          routeGroupId: "primary",
          target: agentRevisionTarget,
          policyRevisionId: null,
          trafficWeight: 10_000,
          priorityNo: 1,
          effectiveFrom: null,
          effectiveUntil: null,
          contentDigest: `sha256:${"a".repeat(64)}`,
        },
        projection: {
          eligibilityState: "eligible",
          invalidReason: null,
          projectionVersionNo: 3,
        },
      }),
    ).toMatchObject({
      active_route_revision_id: "revision-2",
      active_route_activation_id: "activation-2",
      activation_state: "active",
      eligibility_state: "eligible",
      projection_version_no: 3,
      // 判别 target：agent 分支，只含 Agent 事实。
      target: agentRevisionTargetWire,
    });
  });

  it("Agent DTO target 不含 runtime 字段（精确键集合，不依赖 flat 猜测）", () => {
    const dto = projectAdminRoute({
      route: {
        id: "route-1",
        routeSetId: "set-1",
        routeKey: "primary",
        routeState: "enabled",
        updatedAt: new Date("2026-08-11T00:00:00.000Z"),
      },
      activation: {
        id: "activation-2",
        routeRevisionId: "revision-2",
        activationSequence: 2,
        activationState: "active",
        activatedAt: new Date("2026-08-11T00:01:00.000Z"),
      },
      revision: {
        id: "revision-2",
        routeGroupId: "primary",
        target: agentRevisionTarget,
        policyRevisionId: null,
        trafficWeight: 10_000,
        priorityNo: 1,
        effectiveFrom: null,
        effectiveUntil: null,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
      projection: {
        eligibilityState: "eligible",
        invalidReason: null,
        projectionVersionNo: 3,
      },
    });
    // 精确相等：agent target 恰好六个键，绝不携带 runtime_revision_id。
    expect(dto.target).toEqual(agentRevisionTargetWire);
    expect(dto.target).not.toHaveProperty("runtime_revision_id");
    // 顶层不再保留 flat target-specific 字段。
    expect(dto).not.toHaveProperty("agent_revision_id");
    expect(dto).not.toHaveProperty("runtime_revision_id");
  });

  it("Runtime DTO target 不含 Agent 字段", () => {
    const dto = projectAdminRoute({
      route: {
        id: "route-1",
        routeSetId: "set-1",
        routeKey: "primary",
        routeState: "enabled",
        updatedAt: new Date("2026-08-11T00:00:00.000Z"),
      },
      activation: {
        id: "activation-2",
        routeRevisionId: "revision-2",
        activationSequence: 2,
        activationState: "active",
        activatedAt: new Date("2026-08-11T00:01:00.000Z"),
      },
      revision: {
        id: "revision-2",
        routeGroupId: "primary",
        target: { kind: "runtime", runtimeRevisionId: "runtime-revision-1" },
        policyRevisionId: null,
        trafficWeight: 10_000,
        priorityNo: 1,
        effectiveFrom: null,
        effectiveUntil: null,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
      projection: {
        eligibilityState: "eligible",
        invalidReason: null,
        projectionVersionNo: 3,
      },
    });
    expect(dto.target).toEqual({ kind: "runtime", runtime_revision_id: "runtime-revision-1" });
    expect(dto.target).not.toHaveProperty("agent_revision_id");
    expect(dto).not.toHaveProperty("agent_revision_id");
    expect(dto).not.toHaveProperty("runtime_revision_id");
  });

  it("Authority 缺失时明确返回 target=null，不制造假 ID", () => {
    expect(
      projectAdminRoute({
        route: {
          id: "route-1",
          routeSetId: "set-1",
          routeKey: "primary",
          routeState: "enabled",
          updatedAt: new Date("2026-08-11T00:00:00.000Z"),
        },
        activation: null,
        revision: null,
        projection: null,
      }),
    ).toMatchObject({
      target: null,
      active_route_revision_id: null,
      active_route_activation_id: null,
      eligibility_state: "missing",
      projection_version_no: null,
    });
  });

  it("RouteSet 投影保留租户、Scope、版本与判别 target", () => {
    expect(
      projectAdminRouteSet({
        id: "set-1",
        tenantId: "tenant-1",
        targetKind: "agent",
        targetIdentity: "agent-1",
        agentId: "agent-1",
        routeScopeKey: "prod",
        routeScopeJson: { environment: "prod" },
        versionNo: 4,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
        updatedAt: new Date("2026-08-11T00:01:00.000Z"),
      }),
    ).toMatchObject({
      tenant_id: "tenant-1",
      route_scope_key: "prod",
      version_no: 4,
      target: { kind: "agent", agent_id: "agent-1" },
    });
  });
});
