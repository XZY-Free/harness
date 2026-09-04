import { describe, expect, it } from "vitest";
import {
  computeToolExecutionContractDigest,
  parseToolExecutionContract,
} from "./tool-execution-contract";

describe("Tool execution contract", () => {
  const contract = {
    timeoutMs: 10_000,
    idempotencySupport: "header" as const,
    sideEffectMode: "write" as const,
    verificationMode: "provider_response" as const,
    responseLimits: { maxBytes: 64_000 },
    providerOperationMetadata: { path: "/send", effectType: "send" },
  };

  it("规范化稳定合同并计算 canonical digest", () => {
    const parsed = parseToolExecutionContract(contract);
    expect(parsed).toEqual(contract);
    expect(computeToolExecutionContractDigest(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      computeToolExecutionContractDigest({
        providerOperationMetadata: { path: "/send", effectType: "send" },
        responseLimits: { maxBytes: 64_000 },
        verificationMode: "provider_response",
        sideEffectMode: "write",
        idempotencySupport: "header",
        timeoutMs: 10_000,
      }),
    ).toBe(computeToolExecutionContractDigest(parsed));
  });

  it("允许无幂等保障合同但拒绝未知字段", () => {
    expect(parseToolExecutionContract({ ...contract, idempotencySupport: "none" })).toMatchObject({
      idempotencySupport: "none",
      sideEffectMode: "write",
    });
    expect(() => parseToolExecutionContract({ ...contract, secret: "x" })).toThrow(/未知字段/);
    expect(() => parseToolExecutionContract({ ...contract, verificationMode: "none" })).toThrow(
      /provider_response/,
    );
  });
});
