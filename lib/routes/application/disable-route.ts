import { randomUUID } from "node:crypto";
import {
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
} from "@/lib/routes/domain/route-revision";
import type {
  RouteRow,
  RouteSetActivationStore,
} from "@/lib/routes/persistence/route-set-activation-store";

export interface DisableRouteResult {
  route: RouteRow;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeActivationId: string;
  previousRouteActivationId: string;
  routeGroupId: string;
  auditEventId: string;
  affectsNewInvocationsOnly: true;
}

export interface DisableRouteCommand {
  tenantId: string;
  routeSetId: string;
  routeId: string;
  expectedVersionNo: number;
  actor: {
    tenantId: string;
    actorType: "user" | "service" | "workload" | "system";
    actorId: string;
  };
  reason: string;
  requestId: string;
  idempotencyKey: string;
  idempotencyCompletion?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: DisableRouteResult) => string;
  };
}

export class RouteDisableAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteDisableAuthorityError";
  }
}

export function createDisableRoute(dependencies: {
  store: RouteSetActivationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function disableRoute(command: DisableRouteCommand): Promise<DisableRouteResult> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("DisableRoute actor tenant 与命令 tenant 不一致");
    }
    if (!command.reason.trim()) throw new Error("DisableRoute reason 不能为空");

    return dependencies.store.transaction(async (session) => {
      const routeSet = await session.lockRouteSet({
        tenantId: command.tenantId,
        routeSetId: command.routeSetId,
      });
      if (!routeSet) throw new RouteSetNotFoundError(command.routeSetId);
      if (routeSet.versionNo !== command.expectedVersionNo) {
        throw new RouteSetVersionConflictError(
          command.routeSetId,
          command.expectedVersionNo,
          routeSet.versionNo,
        );
      }

      const routes = await session.listRoutesBySet(command.routeSetId);
      const route = routes.find((candidate) => candidate.id === command.routeId);
      if (!route) throw new RouteNotFoundError(command.routeId);

      const latestActivation = await session.findLatestActivation(command.routeId);
      if (
        !latestActivation ||
        latestActivation.tenantId !== command.tenantId ||
        latestActivation.routeId !== command.routeId ||
        latestActivation.routeSetId !== command.routeSetId
      ) {
        throw new RouteDisableAuthorityError(
          `Route ${command.routeId} latest Activation 缺失或关系不一致`,
        );
      }
      const revision = await session.findRevisionById(latestActivation.routeRevisionId);
      if (
        !revision ||
        revision.tenantId !== command.tenantId ||
        revision.routeId !== command.routeId ||
        revision.routeSetId !== command.routeSetId
      ) {
        throw new RouteDisableAuthorityError(
          `Route ${command.routeId} latest Activation 指向的 Revision 缺失或关系不一致`,
        );
      }

      const occurredAt = now();
      const nextVersionNo = routeSet.versionNo + 1;
      const activation = await session.appendActivation({
        id: newId(),
        tenantId: command.tenantId,
        routeId: command.routeId,
        routeRevisionId: revision.id,
        routeSetId: command.routeSetId,
        activationSequence: await session.nextActivationSequence(command.routeId),
        activationState: "disabled",
        previousRouteRevisionId: latestActivation.routeRevisionId,
        previousRouteActivationId: latestActivation.id,
        routeSetVersionNo: nextVersionNo,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        reason: command.reason,
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        now: occurredAt,
      });
      const disabledRoute = await session.updateRouteProjection({
        routeId: command.routeId,
        revision,
        routeState: "disabled",
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
        actionType: "route.disable",
        routeId: command.routeId,
        after: {
          route_id: command.routeId,
          route_set_id: command.routeSetId,
          route_set_version_no: nextVersionNo,
          route_revision_id: revision.id,
          route_activation_id: activation.id,
          activation_state: "disabled",
        },
        reason: command.reason,
        requestId: command.requestId,
        occurredAt,
      });
      await session.appendOutbox({
        id: newId(),
        tenantId: command.tenantId,
        eventKey: `route-disabled:${command.routeId}:${activation.activationSequence}`,
        eventType: "route.disabled",
        aggregateId: command.routeId,
        aggregateVersion: activation.activationSequence,
        payload: {
          route_id: command.routeId,
          route_revision_id: revision.id,
          reason: command.reason,
        },
        occurredAt,
      });

      const result: DisableRouteResult = {
        route: disabledRoute,
        routeSetId: command.routeSetId,
        routeSetVersionNo: nextVersionNo,
        routeRevisionId: revision.id,
        routeActivationId: activation.id,
        previousRouteActivationId: latestActivation.id,
        routeGroupId: revision.routeGroupId,
        auditEventId,
        affectsNewInvocationsOnly: true,
      };
      if (command.idempotencyCompletion) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotencyCompletion.recordId,
          tenantId: command.tenantId,
          commandScope: `route.disable:${command.routeId}`,
          httpStatus: command.idempotencyCompletion.httpStatus,
          responseRef: command.idempotencyCompletion.responseRef ?? command.routeId,
          responseRedactedJson: command.idempotencyCompletion.serializeResponse(result),
          completedAt: occurredAt,
        });
        if (!completed) throw new Error("DisableRoute 幂等记录无法完成");
      }
      return result;
    });
  };
}
