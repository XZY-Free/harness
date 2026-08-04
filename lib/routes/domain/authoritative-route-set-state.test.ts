/**
 * AuthoritativeRouteSetState 单元测试 — 投影漂移检测。
 */

import { describe, it, expect } from "vitest";
import { detectProjectionDrift } from "./authoritative-route-set-state";
import type { AuthoritativeRouteSetState } from "./authoritative-route-set-state";

function makeState(routes: Partial<AuthoritativeRouteSetState> = {}): AuthoritativeRouteSetState {
  return {
    routeSetId: "rs-1",
    tenantId: "t1",
    agentId: "a1",
    routeScopeKey: "prod",
    versionNo: 1,
    routes: [],
    ...routes,
  };
}

describe("detectProjectionDrift", () => {
  it("无漂移 → hasDrift=false", () => {
    const state = makeState({
      routes: [{
        routeId: "r1",
        routeKey: "primary",
        activeRouteRevisionId: "rev-1",
        activeRevision: {
          agentRevisionId: "ar-1",
          runtimeRevisionId: "rr-1",
          policyRevisionId: null,
          modelPolicyRevisionId: null,
          toolsetRevisionId: null,
          trafficWeight: 10000,
          priorityNo: 0,
          effectiveFrom: null,
          effectiveUntil: null,
          eligibilityConditions: {},
          routeGroupId: "primary",
        },
        activationState: "active",
        latestActivationId: "act-1",
        previousRouteRevisionId: null,
      }],
    });
    const result = detectProjectionDrift(state, [{
      routeId: "r1",
      routeKey: "primary",
      agentRevisionId: "ar-1",
      runtimeRevisionId: "rr-1",
      activeRouteRevisionId: "rev-1",
      routeState: "enabled",
    }]);
    expect(result.hasDrift).toBe(false);
  });

  it("Revision 不一致 → revision_mismatch", () => {
    const state = makeState({
      routes: [{
        routeId: "r1",
        routeKey: "primary",
        activeRouteRevisionId: "rev-2",
        activeRevision: null,
        activationState: "active",
        latestActivationId: "act-1",
        previousRouteRevisionId: null,
      }],
    });
    const result = detectProjectionDrift(state, [{
      routeId: "r1",
      routeKey: "primary",
      agentRevisionId: "ar-1",
      runtimeRevisionId: "rr-1",
      activeRouteRevisionId: "rev-1",
      routeState: "enabled",
    }]);
    expect(result.hasDrift).toBe(true);
    expect(result.drifts[0].kind).toBe("revision_mismatch");
  });

  it("投影缺失 Route → missing_in_projection", () => {
    const state = makeState({
      routes: [{
        routeId: "r1",
        routeKey: "primary",
        activeRouteRevisionId: "rev-1",
        activeRevision: null,
        activationState: "active",
        latestActivationId: "act-1",
        previousRouteRevisionId: null,
      }],
    });
    const result = detectProjectionDrift(state, []);
    expect(result.hasDrift).toBe(true);
    expect(result.drifts[0].kind).toBe("missing_in_projection");
  });

  it("状态不一致 → state_mismatch", () => {
    const state = makeState({
      routes: [{
        routeId: "r1",
        routeKey: "primary",
        activeRouteRevisionId: "rev-1",
        activeRevision: null,
        activationState: "disabled",
        latestActivationId: "act-1",
        previousRouteRevisionId: null,
      }],
    });
    const result = detectProjectionDrift(state, [{
      routeId: "r1",
      routeKey: "primary",
      agentRevisionId: "ar-1",
      runtimeRevisionId: "rr-1",
      activeRouteRevisionId: "rev-1",
      routeState: "enabled",
    }]);
    expect(result.hasDrift).toBe(true);
    expect(result.drifts[0].kind).toBe("state_mismatch");
  });
});
