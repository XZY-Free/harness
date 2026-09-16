/** 独立的 CI/CD Service Identity 动作白名单；不生成或解析执行凭据。 */
import type { ActionCode } from "@/lib/identity/action-codes";

/**
 * Independently authenticated service identity.
 *
 * This is deliberately not a WorkloadToken principal: execution credentials
 * are reserved for an active Invocation ownership generation.
 */
export interface ServicePrincipal {
  tenantId: string;
  audience: "admin";
  callerType: "service";
  serviceId: string;
}

export function isServicePrincipal(value: { callerType?: unknown }): value is ServicePrincipal {
  return value.callerType === "service";
}

const SERVICE_ACTIONS: Readonly<Record<string, readonly ActionCode[]>> = {
  cicd: ["artifact.attestation.verify", "agent.revision.create", "deletion.request"],
};

export function isServiceActionAllowed(serviceId: string, actionCode: ActionCode): boolean {
  return SERVICE_ACTIONS[serviceId]?.includes(actionCode) === true;
}
