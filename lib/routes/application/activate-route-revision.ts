import { randomUUID } from "node:crypto";
import {
  AgentCapabilityUnsupportedError,
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteIdempotencyCompletionError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  computeRouteRevisionContentDigest,
  validateRouteRevisionContent,
} from "../domain/route-revision";
import type { RouteRevisionContent } from "../domain/route-revision";
import type {
  RouteActorType,
  RouteControlStore,
  RouteProjection,
  RouteSetProjection,
} from "../persistence/route-control-store";
import type {
  RouteActivationRecord,
  RouteRevisionRecord,
} from "../persistence/route-revision-record";

export interface ActivateRouteRevisionResult {
  route: RouteProjection;
  routeSet: RouteSetProjection;
  routeRevision: RouteRevisionRecord;
  routeActivation: RouteActivationRecord;
  etag: string;
  auditEventId: string;
  revisionAuditEventId: string | null;
  activationOutboxEventId: string;
  revisionOutboxEventId: string | null;
  affectsNewInvocationsOnly: true;
}

export interface ActivateRouteRevisionCommand {
  tenantId: string;
  routeSetId: string;
  routeId?: string;
  routeSetExpectedVersionNo: number;
  content: RouteRevisionContent;
  activationState?: "active" | "disabled";
  actor: { tenantId: string; actorType: RouteActorType; actorId: string };
  reason: string;
  requestId: string;
  idempotencyKey: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: ActivateRouteRevisionResult) => string;
  };
}

export function createActivateRouteRevision(dependencies: {
  store: RouteControlStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function activateRouteRevision(
    command: ActivateRouteRevisionCommand,
  ): Promise<ActivateRouteRevisionResult> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("RouteActivation actor tenant 与命令 tenant 不一致");
    }
    validateRouteRevisionContent(command.content);

    return dependencies.store.transaction(async (session) => {
      const routeSet = await session.lockRouteSet(command.tenantId, command.routeSetId);
      if (!routeSet) throw new RouteSetNotFoundError(command.routeSetId);

      const route = await session.resolveRouteIdentity({
        routeId: command.routeId,
        routeSetId: command.routeSetId,
        content: command.content,
        now: now(),
      });
      const replay = await session.findActivationByIdempotency(route.id, command.idempotencyKey);
      if (replay) {
        return buildResult({
          route: {
            ...route,
            agentRevisionId: replay.revision.agentRevisionId,
            runtimeRevisionId: replay.revision.runtimeRevisionId,
            trafficWeight: replay.revision.trafficWeight,
            priorityNo: replay.revision.priorityNo,
            routeState: replay.activation.activationState === "disabled" ? "disabled" : "enabled",
            effectiveFrom: replay.revision.effectiveFrom,
            effectiveUntil: replay.revision.effectiveUntil,
            activeRouteRevisionId: replay.revision.id,
            updatedAt: replay.activation.activatedAt,
          },
          routeSet: { ...routeSet, versionNo: replay.activation.routeSetVersionNo },
          revision: replay.revision,
          activation: replay.activation,
          auditEventId: "",
          revisionAuditEventId: null,
          activationOutboxEventId: "",
          revisionOutboxEventId: null,
        });
      }

      if (routeSet.versionNo !== command.routeSetExpectedVersionNo) {
        throw new RouteSetVersionConflictError(
          command.routeSetId,
          command.routeSetExpectedVersionNo,
          routeSet.versionNo,
        );
      }

      const agentRevision = await session.findAgentRevision(command.content.agentRevisionId);
      if (!agentRevision || agentRevision.revisionState !== "published") {
        throw new RevisionNotPublishedError(
          command.content.agentRevisionId,
          "agent",
          agentRevision?.revisionState ?? "not_found",
        );
      }
      if (agentRevision.agentId !== routeSet.agentId) {
        throw new RevisionNotPublishedError(
          command.content.agentRevisionId,
          "agent",
          "wrong_agent",
        );
      }

      const runtimeRevision = await session.findRuntimeRevision(command.content.runtimeRevisionId);
      if (!runtimeRevision || runtimeRevision.revisionState !== "published") {
        throw new RevisionNotPublishedError(
          command.content.runtimeRevisionId,
          "runtime",
          runtimeRevision?.revisionState ?? "not_found",
        );
      }

      for (const [artifactType, revisionId] of [
        ["agent_revision", command.content.agentRevisionId],
        ["runtime_revision", command.content.runtimeRevisionId],
      ] as const) {
        if (
          await session.hasVerifiedAttestation({
            tenantId: command.tenantId,
            artifactType,
            revisionId,
          })
        ) {
          continue;
        }
        throw new ArtifactNotVerifiedForRouteError(revisionId, artifactType);
      }

      const runtimeCapabilities = new Set(runtimeRevision.capabilities);
      const missingCapabilities = agentRevision.requiredCapabilities.filter(
        (capability) => !runtimeCapabilities.has(capability),
      );
      if (missingCapabilities.length > 0) {
        throw new AgentCapabilityUnsupportedError(
          missingCapabilities,
          agentRevision.id,
          runtimeRevision.id,
        );
      }

      const occurredAt = now();
      const contentDigest = computeRouteRevisionContentDigest(command.content);
      let revision = await session.findRevisionByContent(route.id, contentDigest);
      let revisionAuditEventId: string | null = null;
      let revisionOutboxEventId: string | null = null;
      if (!revision) {
        revision = await session.appendRevision({
          id: newId(),
          tenantId: command.tenantId,
          routeId: route.id,
          routeSetId: command.routeSetId,
          revisionNo: await session.nextRevisionNo(route.id),
          content: command.content,
          contentDigest,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          now: occurredAt,
        });
        revisionAuditEventId = newId();
        await session.appendAudit({
          id: revisionAuditEventId,
          tenantId: command.tenantId,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          actionType: "route.revision.create",
          routeId: route.id,
          after: {
            route_revision_id: revision.id,
            revision_no: revision.revisionNo,
            content_digest: contentDigest,
          },
          reason: "创建并验证不可变 RouteRevision",
          requestId: command.requestId,
          occurredAt,
        });
        revisionOutboxEventId = newId();
        await session.appendOutbox({
          id: revisionOutboxEventId,
          tenantId: command.tenantId,
          eventKey: `route-revision-validated:${revision.id}`,
          eventType: "route.revision.validated",
          routeId: route.id,
          payload: {
            route_revision_id: revision.id,
            revision_no: revision.revisionNo,
            content_digest: contentDigest,
          },
          occurredAt,
        });
      }

      const nextVersionNo = routeSet.versionNo + 1;
      const activation = await session.appendActivation({
        id: newId(),
        tenantId: command.tenantId,
        routeId: route.id,
        routeRevisionId: revision.id,
        activationSequence: await session.nextActivationSequence(route.id),
        activationState: command.activationState ?? "active",
        previousRouteRevisionId: route.activeRouteRevisionId,
        routeSetVersionNo: nextVersionNo,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        reason: command.reason,
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        now: occurredAt,
      });
      const updatedRoute = await session.updateRouteProjection({
        routeId: route.id,
        revision,
        routeState: command.activationState === "disabled" ? "disabled" : "enabled",
        now: occurredAt,
      });
      const updatedRouteSet = await session.advanceRouteSetVersion({
        routeSetId: command.routeSetId,
        expectedVersionNo: routeSet.versionNo,
        now: occurredAt,
      });
      if (!updatedRouteSet) {
        throw new RouteSetVersionConflictError(command.routeSetId, routeSet.versionNo, -1);
      }

      const auditEventId = newId();
      await session.appendAudit({
        id: auditEventId,
        tenantId: command.tenantId,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        actionType: "route.update",
        routeId: route.id,
        after: {
          route_revision_id: revision.id,
          route_activation_id: activation.id,
          previous_route_revision_id: activation.previousRouteRevisionId,
          route_set_version_no: nextVersionNo,
          activation_state: activation.activationState,
        },
        reason: command.reason,
        requestId: command.requestId,
        occurredAt,
      });
      const activationOutboxEventId = newId();
      await session.appendOutbox({
        id: activationOutboxEventId,
        tenantId: command.tenantId,
        eventKey: `route-activation:${activation.id}`,
        eventType: activation.activationState === "disabled" ? "route.disabled" : "route.activated",
        routeId: route.id,
        payload: {
          route_revision_id: revision.id,
          route_activation_id: activation.id,
          previous_route_revision_id: activation.previousRouteRevisionId,
          route_set_version_no: nextVersionNo,
        },
        occurredAt,
      });

      const result = buildResult({
        route: updatedRoute,
        routeSet: updatedRouteSet,
        revision,
        activation,
        auditEventId,
        revisionAuditEventId,
        activationOutboxEventId,
        revisionOutboxEventId,
      });
      if (command.idempotency) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotency.recordId,
          httpStatus: command.idempotency.httpStatus,
          responseRef: command.idempotency.responseRef ?? route.id,
          responseRedactedJson: command.idempotency.serializeResponse(result),
          completedAt: occurredAt,
        });
        if (!completed) throw new RouteIdempotencyCompletionError(command.idempotency.recordId);
      }
      return result;
    });
  };
}

function buildResult(params: {
  route: RouteProjection;
  routeSet: RouteSetProjection;
  revision: RouteRevisionRecord;
  activation: RouteActivationRecord;
  auditEventId: string;
  revisionAuditEventId: string | null;
  activationOutboxEventId: string;
  revisionOutboxEventId: string | null;
}): ActivateRouteRevisionResult {
  return {
    route: params.route,
    routeSet: params.routeSet,
    routeRevision: params.revision,
    routeActivation: params.activation,
    etag: `route-set-${params.activation.routeSetVersionNo}`,
    auditEventId: params.auditEventId,
    revisionAuditEventId: params.revisionAuditEventId,
    activationOutboxEventId: params.activationOutboxEventId,
    revisionOutboxEventId: params.revisionOutboxEventId,
    affectsNewInvocationsOnly: true,
  };
}
