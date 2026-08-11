import { describe, expect, it, vi } from "vitest";

import type { RouteSetActivationStore } from "@/lib/routes/persistence/route-set-activation-store";
import { createDisableRoute } from "./disable-route";

const NOW = new Date("2026-08-11T00:00:00.000Z");

describe("DisableRoute", () => {
  it("复用 latest Activation 的权威 Revision，只追加 disabled Activation", async () => {
    const appendRevision = vi.fn();
    const appendActivation = vi.fn(async (params) => ({
      ...params,
      activatedAt: params.now,
    }));
    const updateRouteProjection = vi.fn(async ({ revision, now }) => ({
      id: "route-1",
      routeSetId: "route-set-1",
      routeKey: "primary",
      agentRevisionId: revision.agentRevisionId,
      runtimeRevisionId: revision.runtimeRevisionId,
      trafficWeight: revision.trafficWeight,
      priorityNo: revision.priorityNo,
      routeState: "disabled" as const,
      effectiveFrom: revision.effectiveFrom,
      effectiveUntil: revision.effectiveUntil,
      activeRouteRevisionId: revision.id,
      createdAt: NOW,
      updatedAt: now,
    }));
    const appendAudit = vi.fn(async () => undefined);
    const appendOutbox = vi.fn(async () => undefined);
    const session = {
      lockRouteSet: vi.fn(async () => ({
        id: "route-set-1",
        tenantId: "tenant-1",
        agentId: "agent-1",
        routeScopeKey: "prod",
        routeScopeJson: {},
        versionNo: 4,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      listRoutesBySet: vi.fn(async () => [
        {
          id: "route-1",
          routeSetId: "route-set-1",
          routeKey: "primary",
          agentRevisionId: "agent-revision-1",
          runtimeRevisionId: "runtime-revision-1",
          trafficWeight: 10_000,
          priorityNo: 0,
          routeState: "enabled" as const,
          effectiveFrom: null,
          effectiveUntil: null,
          activeRouteRevisionId: "route-revision-1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
      findLatestActivation: vi.fn(async () => ({
        id: "activation-2",
        tenantId: "tenant-1",
        routeId: "route-1",
        routeRevisionId: "route-revision-1",
        routeSetId: "route-set-1",
        activationSequence: 2,
        activationState: "active" as const,
        previousRouteRevisionId: null,
        previousRouteActivationId: null,
        routeSetVersionNo: 4,
        activatedByType: "service" as const,
        activatedBy: "deployer",
        reason: "activate",
        requestId: "request-activate",
        idempotencyKey: "activate-key",
        activatedAt: NOW,
      })),
      findRevisionById: vi.fn(async () => ({
        id: "route-revision-1",
        tenantId: "tenant-1",
        routeId: "route-1",
        routeSetId: "route-set-1",
        routeKey: "primary",
        revisionNo: 1,
        agentRevisionId: "agent-revision-1",
        runtimeRevisionId: "runtime-revision-1",
        policyRevisionId: "policy-revision-1",
        modelPolicyRevisionId: "model-policy-revision-1",
        toolsetRevisionId: "toolset-revision-1",
        trafficAllocationJson: { weightBasisPoints: 10_000 },
        routeGroupId: "stable",
        selectorDigest: "sha256:selector",
        trafficWeight: 10_000,
        priorityNo: 0,
        effectiveFrom: null,
        effectiveUntil: null,
        eligibilityConditionsJson: { attributes: { region: "cn" } },
        contentDigest: "sha256:content",
        createdByType: "service" as const,
        createdBy: "deployer",
        validatedAt: NOW,
        createdAt: NOW,
      })),
      nextActivationSequence: vi.fn(async () => 3),
      appendRevision,
      appendActivation,
      updateRouteProjection,
      advanceRouteSetVersion: vi.fn(async () => ({ versionNo: 5 })),
      appendAudit,
      appendOutbox,
      completeIdempotency: vi.fn(async () => true),
    };
    const store = {
      transaction: async (operation: (value: typeof session) => Promise<unknown>) =>
        operation(session),
    } as unknown as RouteSetActivationStore;
    const ids = ["activation-3", "audit-1", "outbox-1"];
    const disableRoute = createDisableRoute({
      store,
      now: () => NOW,
      newId: () => {
        const id = ids.shift();
        if (!id) throw new Error("测试 ID 已耗尽");
        return id;
      },
    });

    const result = await disableRoute({
      tenantId: "tenant-1",
      routeSetId: "route-set-1",
      routeId: "route-1",
      expectedVersionNo: 4,
      actor: { tenantId: "tenant-1", actorType: "service", actorId: "deployer" },
      reason: "manual disable",
      requestId: "request-disable",
      idempotencyKey: "disable-key",
    });

    expect(appendRevision).not.toHaveBeenCalled();
    expect(appendActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "activation-3",
        routeRevisionId: "route-revision-1",
        activationState: "disabled",
        previousRouteRevisionId: "route-revision-1",
        previousRouteActivationId: "activation-2",
        routeSetVersionNo: 5,
      }),
    );
    expect(updateRouteProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "route-1",
        routeState: "disabled",
        revision: expect.objectContaining({
          id: "route-revision-1",
          policyRevisionId: "policy-revision-1",
          routeGroupId: "stable",
          selectorDigest: "sha256:selector",
        }),
      }),
    );
    expect(appendOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "route.disabled", aggregateId: "route-1" }),
    );
    expect(result.routeRevisionId).toBe("route-revision-1");
    expect(result.routeActivationId).toBe("activation-3");
    expect(result.routeGroupId).toBe("stable");
    expect(result.routeSetVersionNo).toBe(5);
  });
});
