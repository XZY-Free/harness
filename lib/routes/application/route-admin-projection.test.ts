import { describe, expect, it } from "vitest";
import { projectAdminRoute, projectAdminRouteSet } from "./route-admin-projection";

describe("route admin projection", () => {
  it("只从 latest Activation 指向的 Revision 投影当前路由", () => {
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
          agentRevisionId: "agent-revision-1",
          runtimeRevisionId: "runtime-revision-1",
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
    });
  });

  it("Authority 缺失时明确返回 missing，不制造假 ID", () => {
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
      active_route_revision_id: null,
      active_route_activation_id: null,
      eligibility_state: "missing",
      projection_version_no: null,
    });
  });

  it("RouteSet 投影保留租户、Scope 与版本", () => {
    expect(
      projectAdminRouteSet({
        id: "set-1",
        tenantId: "tenant-1",
        agentId: "agent-1",
        routeScopeKey: "prod",
        routeScopeJson: { environment: "prod" },
        versionNo: 4,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
        updatedAt: new Date("2026-08-11T00:01:00.000Z"),
      }),
    ).toMatchObject({ tenant_id: "tenant-1", route_scope_key: "prod", version_no: 4 });
  });
});
