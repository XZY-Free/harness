import {
  ENTERPRISE_ATTRIBUTE_CATALOG,
  type EnterpriseAttributeKey,
  type JsonValue,
} from "@/lib/identity/enterprise-user";

export interface EnterpriseProfileSource {
  readonly sourceSystem: string;
  readonly trusted: boolean;
  readonly maxFreshAgeMs: number;
  readonly maxStaleAgeMs: number;
  readonly observe?: EnterpriseProfileSourceOperation;
  readonly refresh?: EnterpriseProfileSourceOperation;
}

export interface EnterpriseProfileSourceSubject {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly externalSubject: string;
}

export interface EnterpriseProfileSourceContext {
  readonly subject: EnterpriseProfileSourceSubject;
  readonly signal: AbortSignal;
  readonly now: Date;
  readonly trustedAuthenticationClaims: Readonly<Record<string, unknown>>;
}

export interface EnterpriseProfileObservation {
  readonly tenantId: string;
  readonly externalSubject: string;
  readonly sourceSystem: string;
  readonly attributes: Record<string, unknown>;
  readonly verifiedAt: Date;
  readonly freshUntil: Date;
  readonly staleUntil: Date;
}

export type EnterpriseProfileSourceResult =
  | { readonly status: "observed"; readonly observation: EnterpriseProfileObservation }
  | { readonly status: "unchanged" }
  | { readonly status: "unavailable"; readonly code?: string };

export type EnterpriseProfileSourceOperation = (
  context: EnterpriseProfileSourceContext,
) => Promise<EnterpriseProfileSourceResult>;

export class EnterpriseProfileObservationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseProfileObservationError";
  }
}

export function validateEnterpriseProfileObservation(
  observation: EnterpriseProfileObservation,
  source: EnterpriseProfileSource,
  now: Date,
): {
  tenantId: string;
  externalSubject: string;
  sourceSystem: string;
  attributes: Partial<Record<EnterpriseAttributeKey, string | number | boolean | JsonValue>>;
  verifiedAt: Date;
  freshUntil: Date;
  staleUntil: Date;
} {
  if (!source.trusted) {
    throw new EnterpriseProfileObservationError("source_untrusted", "企业资料来源未受信");
  }
  if (observation.tenantId.trim().length === 0 || observation.externalSubject.trim().length === 0) {
    throw new EnterpriseProfileObservationError("subject_invalid", "企业资料观察缺少主体");
  }
  if (observation.sourceSystem !== source.sourceSystem) {
    throw new EnterpriseProfileObservationError("source_invalid", "企业资料来源不匹配");
  }
  const verifiedAt = validDate(observation.verifiedAt, "verifiedAt");
  const freshUntil = validDate(observation.freshUntil, "freshUntil");
  const staleUntil = validDate(observation.staleUntil, "staleUntil");
  const nowMs = validDate(now, "now").getTime();
  if (verifiedAt.getTime() > nowMs + 60_000) {
    throw new EnterpriseProfileObservationError("verified_at_future", "verifiedAt 超出时钟容差");
  }
  if (verifiedAt > freshUntil || freshUntil > staleUntil) {
    throw new EnterpriseProfileObservationError("time_order_invalid", "企业资料期限顺序非法");
  }
  if (!validLimit(source.maxFreshAgeMs) || !validLimit(source.maxStaleAgeMs)) {
    throw new EnterpriseProfileObservationError(
      "source_limits_invalid",
      "企业资料来源期限上限非法",
    );
  }
  if (freshUntil.getTime() > verifiedAt.getTime() + source.maxFreshAgeMs) {
    throw new EnterpriseProfileObservationError("fresh_limit_exceeded", "freshUntil 超出来源上限");
  }
  if (staleUntil.getTime() > freshUntil.getTime() + source.maxStaleAgeMs) {
    throw new EnterpriseProfileObservationError("stale_limit_exceeded", "staleUntil 超出来源上限");
  }

  return {
    tenantId: observation.tenantId.trim(),
    externalSubject: observation.externalSubject.trim(),
    sourceSystem: observation.sourceSystem,
    attributes: normalizeAttributes(observation.attributes),
    verifiedAt,
    freshUntil,
    staleUntil,
  };
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new EnterpriseProfileObservationError("time_invalid", `${field} 不是有效时间`);
  }
  return value;
}

function validLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

function normalizeAttributes(
  attributes: Record<string, unknown>,
): Partial<Record<EnterpriseAttributeKey, string | number | boolean | JsonValue>> {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new EnterpriseProfileObservationError("attributes_invalid", "企业资料属性必须是对象");
  }
  const normalized: Partial<Record<EnterpriseAttributeKey, string | number | boolean | JsonValue>> =
    {};
  for (const [key, value] of Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(key in ENTERPRISE_ATTRIBUTE_CATALOG)) {
      throw new EnterpriseProfileObservationError(
        "attribute_unknown",
        `企业资料属性未登记：${key}`,
      );
    }
    const descriptor = ENTERPRISE_ATTRIBUTE_CATALOG[key as EnterpriseAttributeKey];
    if (descriptor.valueType === "string" && typeof value === "string" && value.trim()) {
      normalized[key as EnterpriseAttributeKey] = value.trim();
      continue;
    }
    if (descriptor.valueType === "number" && typeof value === "number" && Number.isFinite(value)) {
      normalized[key as EnterpriseAttributeKey] = value;
      continue;
    }
    if (descriptor.valueType === "boolean" && typeof value === "boolean") {
      normalized[key as EnterpriseAttributeKey] = value;
      continue;
    }
    if (descriptor.valueType === "json" && value !== null && isJsonValue(value)) {
      normalized[key as EnterpriseAttributeKey] = value;
      continue;
    }
    throw new EnterpriseProfileObservationError(
      "attribute_type_invalid",
      `企业资料属性类型非法：${key}`,
    );
  }
  return normalized;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}
