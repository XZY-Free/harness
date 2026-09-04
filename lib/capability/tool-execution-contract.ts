import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

export const TOOL_EXECUTION_CONTRACT_KEYS = [
  "timeoutMs",
  "idempotencySupport",
  "sideEffectMode",
  "verificationMode",
  "responseLimits",
  "providerOperationMetadata",
] as const;

export interface ToolExecutionContract {
  timeoutMs: number;
  idempotencySupport: "none" | "header";
  sideEffectMode: "none" | "read" | "write";
  verificationMode: "none" | "provider_response";
  responseLimits: { maxBytes: number };
  providerOperationMetadata: Record<string, unknown>;
}

export class ToolExecutionContractError extends Error {
  constructor(message: string) {
    super(`Tool execution contract 无效：${message}`);
    this.name = "ToolExecutionContractError";
  }
}

export function parseToolExecutionContract(value: unknown): ToolExecutionContract {
  const input = asRecord(value);
  if (!input) throw new ToolExecutionContractError("必须是对象");
  const unknown = Object.keys(input).filter(
    (key) => !(TOOL_EXECUTION_CONTRACT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new ToolExecutionContractError(`包含未知字段：${unknown.sort().join(",")}`);
  }
  const responseLimits = asRecord(input.responseLimits);
  const providerOperationMetadata = asRecord(input.providerOperationMetadata);
  if (!Number.isInteger(input.timeoutMs) || (input.timeoutMs as number) < 100) {
    throw new ToolExecutionContractError("timeoutMs 必须是至少 100 的整数");
  }
  if (input.idempotencySupport !== "none" && input.idempotencySupport !== "header") {
    throw new ToolExecutionContractError("idempotencySupport 非法");
  }
  if (
    input.sideEffectMode !== "none" &&
    input.sideEffectMode !== "read" &&
    input.sideEffectMode !== "write"
  ) {
    throw new ToolExecutionContractError("sideEffectMode 非法");
  }
  if (input.verificationMode !== "none" && input.verificationMode !== "provider_response") {
    throw new ToolExecutionContractError("verificationMode 非法");
  }
  if (
    !responseLimits ||
    Object.keys(responseLimits).some((key) => key !== "maxBytes") ||
    !Number.isInteger(responseLimits.maxBytes) ||
    (responseLimits.maxBytes as number) < 1 ||
    (responseLimits.maxBytes as number) > 10_000_000
  ) {
    throw new ToolExecutionContractError("responseLimits.maxBytes 非法");
  }
  if (!providerOperationMetadata) {
    throw new ToolExecutionContractError("providerOperationMetadata 必须是对象");
  }
  if (
    input.sideEffectMode === "write" &&
    !["create", "update", "delete", "send", "payment", "deploy"].includes(
      String(providerOperationMetadata.effectType ?? ""),
    )
  ) {
    throw new ToolExecutionContractError(
      "write Tool 必须声明合法 providerOperationMetadata.effectType",
    );
  }
  if (input.sideEffectMode === "write" && input.verificationMode !== "provider_response") {
    throw new ToolExecutionContractError("write Tool 必须声明 provider_response verification");
  }
  return {
    timeoutMs: input.timeoutMs as number,
    idempotencySupport: input.idempotencySupport,
    sideEffectMode: input.sideEffectMode,
    verificationMode: input.verificationMode,
    responseLimits: { maxBytes: responseLimits.maxBytes as number },
    providerOperationMetadata: structuredClone(providerOperationMetadata),
  };
}

export function computeToolExecutionContractDigest(value: unknown): string {
  return computeCanonicalDigest(parseToolExecutionContract(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
