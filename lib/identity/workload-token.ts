/** Authority-bound execution credential. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { API_STATUS, apiError, generateRequestId } from "@/lib/http";
import type { ApiAudience } from "@/lib/http";

export const WORKLOAD_TOKEN_SIGNING_SECRET_ENV = "SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET";
export const WORKLOAD_SIGNING_KEY_ID_ENV = "WORKLOAD_SIGNING_KEY_ID";
export const WORKLOAD_TOKEN_FORMAT_VERSION = 1 as const;
export const WORKLOAD_TOKEN_MAX_LENGTH = 16 * 1024;
export const WORKLOAD_TOKEN_DEFAULT_TTL_MS = {
  runtime: 5 * 60 * 1000,
  gateway: 5 * 60 * 1000,
} as const;

export type WorkloadTokenAudience = "runtime" | "gateway";

export interface WorkloadTokenClaims {
  contractVersion: 3;
  type: "execution";
  tenantId: string;
  invocationId: string;
  runtimeRevisionId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  sessionBindingId: string;
  audience: WorkloadTokenAudience;
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

interface WorkloadTokenHeader {
  formatVersion: 1;
  algorithm: "HS256";
  keyId: string;
}

export type WorkloadTokenErrorCode =
  | "missing_token"
  | "malformed_token"
  | "expired_token"
  | "audience_mismatch"
  | "invocation_mismatch"
  | "token_revoked"
  | "missing_jti"
  | "not_current_executor";

export class WorkloadTokenError extends Error {
  constructor(
    public readonly code: WorkloadTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkloadTokenError";
  }
}

function signingSecret(): Buffer {
  const secret = process.env[WORKLOAD_TOKEN_SIGNING_SECRET_ENV];
  if (!secret) {
    throw new WorkloadTokenError("malformed_token", "Workload Token 签名密钥未配置");
  }
  const value = Buffer.from(secret, "utf8");
  if (value.byteLength < 32) {
    throw new WorkloadTokenError("malformed_token", "Workload Token 签名密钥长度不足");
  }
  return value;
}

function signingKeyId(): string {
  const keyId = process.env[WORKLOAD_SIGNING_KEY_ID_ENV]?.trim();
  if (!keyId) {
    throw new WorkloadTokenError("malformed_token", "Workload Token signing key id 未配置");
  }
  return keyId;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson<T>(segment: string, name: string): T {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object expected");
    }
    return value as T;
  } catch {
    throw new WorkloadTokenError("malformed_token", `Workload Token ${name} 非法`);
  }
}

function macFor(parts: string[]): Buffer {
  return createHmac("sha256", signingSecret())
    .update(["snowharness.workload", ...parts].join("\0"), "utf8")
    .digest();
}

function assertClaims(value: unknown): WorkloadTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkloadTokenError("malformed_token", "Workload Token claims 非法");
  }
  const c = value as Partial<WorkloadTokenClaims>;
  const requiredStrings = [
    c.tenantId,
    c.invocationId,
    c.runtimeRevisionId,
    c.attemptId,
    c.ownershipId,
    c.leaseEpoch,
    c.sessionBindingId,
    c.jti,
  ];
  if (
    c.contractVersion !== 3 ||
    c.type !== "execution" ||
    (c.audience !== "runtime" && c.audience !== "gateway") ||
    requiredStrings.some((item) => typeof item !== "string" || item.length === 0) ||
    typeof c.issuedAt !== "number" ||
    !Number.isSafeInteger(c.issuedAt) ||
    typeof c.expiresAt !== "number" ||
    !Number.isSafeInteger(c.expiresAt) ||
    c.expiresAt <= c.issuedAt
  ) {
    throw new WorkloadTokenError("malformed_token", "Workload Token 缺少正式执行 claims");
  }
  if (!/^[1-9][0-9]*$/.test(c.leaseEpoch as string)) {
    throw new WorkloadTokenError("malformed_token", "leaseEpoch 必须是正十进制字符串");
  }
  return c as WorkloadTokenClaims;
}

export function signWorkloadTokenPayload(claims: WorkloadTokenClaims): string {
  const header: WorkloadTokenHeader = {
    formatVersion: 1,
    algorithm: "HS256",
    keyId: signingKeyId(),
  };
  const headerSegment = encode(header);
  const claimsSegment = encode(assertClaims(claims));
  const macSegment = macFor([headerSegment, claimsSegment]).toString("base64url");
  return `wh.${headerSegment}.${claimsSegment}.${macSegment}`;
}

export function decodeWorkloadToken(token: string): WorkloadTokenClaims {
  if (typeof token !== "string" || token.length === 0) {
    throw new WorkloadTokenError("missing_token", "缺少 Workload Token");
  }
  if (token.length > WORKLOAD_TOKEN_MAX_LENGTH) {
    throw new WorkloadTokenError("malformed_token", "Workload Token 超出长度限制");
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "wh") {
    throw new WorkloadTokenError("malformed_token", "Workload Token 格式非法");
  }
  const header = decodeJson<Partial<WorkloadTokenHeader>>(parts[1] ?? "", "header");
  if (
    header.formatVersion !== 1 ||
    header.algorithm !== "HS256" ||
    header.keyId !== signingKeyId()
  ) {
    throw new WorkloadTokenError("malformed_token", "Workload Token header 不符合受管算法");
  }
  const expected = macFor([parts[1] ?? "", parts[2] ?? ""]);
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[3] ?? "", "base64url");
  } catch {
    throw new WorkloadTokenError("malformed_token", "Workload Token MAC 非法");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new WorkloadTokenError("malformed_token", "Workload Token 签名不匹配");
  }
  const claims = assertClaims(decodeJson<unknown>(parts[2] ?? "", "claims"));
  const now = Date.now();
  if (claims.issuedAt > now + 5_000) {
    throw new WorkloadTokenError("malformed_token", "Workload Token issuedAt 超前");
  }
  if (now >= claims.expiresAt) {
    throw new WorkloadTokenError("expired_token", "Workload Token 已过期");
  }
  return claims;
}

export function extractBearerToken(headers: Headers): string | null {
  const value = headers.get("authorization");
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function assertAudienceMatch(
  claims: WorkloadTokenClaims,
  expected: ApiAudience | WorkloadTokenAudience,
): void {
  if (claims.audience !== expected) {
    throw new WorkloadTokenError("audience_mismatch", "Workload Token audience 不匹配");
  }
}

export function assertInvocationMatch(claims: WorkloadTokenClaims, invocationId: string): void {
  if (claims.invocationId !== invocationId) {
    throw new WorkloadTokenError("invocation_mismatch", "Workload Token invocation 不匹配");
  }
}

export function issueWorkloadToken(
  claims: Omit<WorkloadTokenClaims, "issuedAt" | "jti"> & { jti?: string },
): string {
  const issuedAt = Date.now();
  return signWorkloadTokenPayload({ ...claims, jti: claims.jti ?? randomUUID(), issuedAt });
}

export function workloadTokenErrorResponse(
  error: unknown,
  requestId: string = generateRequestId(),
): Response | null {
  if (!(error instanceof WorkloadTokenError)) return null;
  return apiError("AUTHENTICATION_REQUIRED", error.message, { requestId });
}

export { API_STATUS };
