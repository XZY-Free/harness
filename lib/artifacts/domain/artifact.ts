export const ARTIFACT_KINDS = [
  "runtime_revision",
  "skill_package",
  "tool_provider",
  "policy_bundle",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const VERIFICATION_STATES = ["verified", "failed"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST_PATTERN.test(value);
}

/** 从不可变制品引用中提取完整 sha256 digest；旧式占位引用返回 null。 */
export function extractArtifactDigest(reference: string): string | null {
  if (isSha256Digest(reference)) return reference;
  const match = reference.match(/@(?<digest>sha256:[0-9a-f]{64})$/);
  return match?.groups?.digest ?? null;
}
