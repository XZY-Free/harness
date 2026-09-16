import { createHash, randomUUID } from "node:crypto";
import { ENVIRONMENT_TYPES, type EnvironmentType } from "@/lib/persistence/schema/environment";
import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const EnvironmentPolicySchema = z.record(z.string(), z.unknown());
export const EnvironmentExecutionTargetSchema = z.record(z.string(), z.unknown());
export const EnvironmentCapabilitiesSchema = z.record(z.string(), z.unknown());

export interface EnvironmentRevisionInput {
  environmentType: EnvironmentType;
  filesystemPolicyJson: unknown;
  networkPolicyJson: unknown;
  resourceLimitsJson: unknown;
  secretPolicyJson: unknown;
  executionTarget: unknown;
  requiredCapabilities: unknown;
  semanticDigest?: string;
  createdByType: "user" | "service";
  createdById: string;
}

export function computeEnvironmentSemanticDigest(
  input: Omit<EnvironmentRevisionInput, "semanticDigest" | "createdByType" | "createdById">,
): string {
  const value = JSON.stringify({
    environmentType: input.environmentType,
    filesystemPolicyJson: input.filesystemPolicyJson,
    networkPolicyJson: input.networkPolicyJson,
    resourceLimitsJson: input.resourceLimitsJson,
    secretPolicyJson: input.secretPolicyJson,
    executionTarget: input.executionTarget,
    requiredCapabilities: input.requiredCapabilities,
  });
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function validateEnvironmentRevision(
  input: EnvironmentRevisionInput,
): EnvironmentRevisionInput & { semanticDigest: string } {
  if (!ENVIRONMENT_TYPES.includes(input.environmentType))
    throw new Error(`EnvironmentRevision environmentType 非法: ${input.environmentType}`);
  if (!input.createdById) throw new Error("EnvironmentRevision createdById 不能为空");
  const semanticDigest = input.semanticDigest ?? computeEnvironmentSemanticDigest(input);
  if (!digest.safeParse(semanticDigest).success)
    throw new Error("EnvironmentRevision semanticDigest 非法");
  return { ...input, semanticDigest };
}

export function revisionResourceManifest(input: EnvironmentRevisionInput): Record<string, unknown> {
  const validated = validateEnvironmentRevision(input);
  return {
    revisionId: randomUUID(),
    environmentType: validated.environmentType,
    executionTarget: validated.executionTarget,
    requiredCapabilities: validated.requiredCapabilities,
    semanticDigest: validated.semanticDigest,
  };
}
