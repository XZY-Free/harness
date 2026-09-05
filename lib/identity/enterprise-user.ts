/**
 * 企业用户资料领域合同。
 *
 * 本模块只处理部署方 EnterpriseUserAdapter 返回的完整资料快照：校验、规范化与指纹。
 * 不包含任何企业目录连接器、凭证或网络调用。
 */
import { computeCanonicalDigest, rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";

export const ENTERPRISE_ATTRIBUTE_KEYS = [
  "employeeNo",
  "departmentCode",
  "buCode",
  "factoryCode",
  "jobLevel",
  "enterprisePermissions",
  "dataScopes",
] as const;

export type EnterpriseAttributeKey = (typeof ENTERPRISE_ATTRIBUTE_KEYS)[number];
export type EnterpriseAttributeValueType = "string" | "number" | "boolean" | "json";
export type EnterpriseProfileStatus = "active" | "disabled";
export type EnterpriseProfileValidationCode =
  | "enterprise_profile_incomplete"
  | "enterprise_profile_source_invalid"
  | "enterprise_profile_status_invalid"
  | "enterprise_profile_attribute_unknown"
  | "enterprise_profile_attribute_type_invalid";

export interface EnterpriseAttributeDescriptor {
  key: EnterpriseAttributeKey;
  valueType: EnterpriseAttributeValueType;
  sensitive: boolean;
  agentProjectionAllowed: boolean;
  includedInFingerprint: boolean;
}

/**
 * 首批固定目录。企业权限和数据范围是授权事实，永远不允许作为 Agent 字段投影。
 * 新字段必须伴随本目录、同步模型与投影策略的同一版本变更，不能由上游自由透传。
 */
export const ENTERPRISE_ATTRIBUTE_CATALOG: Readonly<
  Record<EnterpriseAttributeKey, EnterpriseAttributeDescriptor>
> = {
  employeeNo: {
    key: "employeeNo",
    valueType: "string",
    sensitive: true,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  departmentCode: {
    key: "departmentCode",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  buCode: {
    key: "buCode",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  factoryCode: {
    key: "factoryCode",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  jobLevel: {
    key: "jobLevel",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  enterprisePermissions: {
    key: "enterprisePermissions",
    valueType: "json",
    sensitive: true,
    agentProjectionAllowed: false,
    includedInFingerprint: true,
  },
  dataScopes: {
    key: "dataScopes",
    valueType: "json",
    sensitive: true,
    agentProjectionAllowed: false,
    includedInFingerprint: true,
  },
};

export interface EnterpriseUserProfileSnapshot {
  externalSubject: string;
  email: string;
  displayName: string | null;
  /** 企业源状态；当前只接受 active、disabled、inactive。 */
  status: string;
  sourceSystem: string;
  /** 仅允许 ENTERPRISE_ATTRIBUTE_CATALOG 中登记的 key。 */
  attributes: Record<string, unknown>;
}

export interface NormalizedEnterpriseUserProfile {
  externalSubject: string;
  email: string;
  displayName: string | null;
  status: EnterpriseProfileStatus;
  sourceSystem: string;
  attributes: Partial<Record<EnterpriseAttributeKey, string | number | boolean | JsonValue>>;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class EnterpriseProfileValidationError extends Error {
  constructor(
    public readonly code: EnterpriseProfileValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseProfileValidationError";
  }
}

/**
 * 规范化部署方返回的完整快照。扩展属性缺失代表当前资料中不存在该事实；值为 null
 * 不具备此语义，必须拒绝，避免把 null 与缺失混为一谈。
 */
export function normalizeEnterpriseUserProfile(
  profile: EnterpriseUserProfileSnapshot,
): NormalizedEnterpriseUserProfile {
  const externalSubject = requireNonBlank(profile.externalSubject, "externalSubject");
  const email = requireNonBlank(profile.email, "email");
  const sourceSystem = requireNonBlank(
    profile.sourceSystem,
    "sourceSystem",
    "enterprise_profile_source_invalid",
  );
  const displayName = normalizeDisplayName(profile.displayName);
  const status = normalizeStatus(profile.status);
  const attributes = normalizeAttributes(profile.attributes);

  return { externalSubject, email, displayName, status, sourceSystem, attributes };
}

/** 指纹只针对规范化的可信业务事实；绝不接收 HTTP 响应、token 或验证时间。 */
export function computeEnterpriseProfileFingerprint(
  profile: NormalizedEnterpriseUserProfile,
): string {
  return computeCanonicalDigest({
    externalSubject: profile.externalSubject,
    email: profile.email,
    displayName: profile.displayName,
    status: profile.status,
    sourceSystem: profile.sourceSystem,
    attributes: Object.fromEntries(
      Object.entries(profile.attributes)
        .filter(
          ([key]) =>
            ENTERPRISE_ATTRIBUTE_CATALOG[key as EnterpriseAttributeKey].includedInFingerprint,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
}

function requireNonBlank(
  value: unknown,
  field: string,
  code: EnterpriseProfileValidationCode = "enterprise_profile_incomplete",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EnterpriseProfileValidationError(code, `企业资料缺少有效 ${field}`);
  }
  return value.trim();
}

function normalizeDisplayName(value: unknown): string | null {
  if (value === null) return null;
  return requireNonBlank(value, "displayName");
}

function normalizeStatus(value: unknown): EnterpriseProfileStatus {
  if (value === "active") return "active";
  if (value === "disabled" || value === "inactive") return "disabled";
  throw new EnterpriseProfileValidationError(
    "enterprise_profile_status_invalid",
    "企业资料状态不是允许值",
  );
}

function normalizeAttributes(
  attributes: Record<string, unknown>,
): Partial<Record<EnterpriseAttributeKey, string | number | boolean | JsonValue>> {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new EnterpriseProfileValidationError(
      "enterprise_profile_attribute_type_invalid",
      "企业扩展属性必须是对象",
    );
  }

  const entries = Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right));
  const normalized: Partial<Record<EnterpriseAttributeKey, string | number | boolean | JsonValue>> =
    {};

  for (const [key, value] of entries) {
    if (!isEnterpriseAttributeKey(key)) {
      throw new EnterpriseProfileValidationError(
        "enterprise_profile_attribute_unknown",
        `企业扩展属性未登记：${key}`,
      );
    }
    normalized[key] = normalizeAttributeValue(ENTERPRISE_ATTRIBUTE_CATALOG[key], value);
  }
  return normalized;
}

function isEnterpriseAttributeKey(key: string): key is EnterpriseAttributeKey {
  return Object.hasOwn(ENTERPRISE_ATTRIBUTE_CATALOG, key);
}

function normalizeAttributeValue(
  descriptor: EnterpriseAttributeDescriptor,
  value: unknown,
): string | number | boolean | JsonValue {
  if (descriptor.valueType === "string") {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  } else if (descriptor.valueType === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  } else if (descriptor.valueType === "boolean") {
    if (typeof value === "boolean") return value;
  } else if (value !== null && isJsonValue(value)) {
    return normalizeJsonSet(value);
  }

  throw new EnterpriseProfileValidationError(
    "enterprise_profile_attribute_type_invalid",
    `企业扩展属性 ${descriptor.key} 的值类型非法`,
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

/** 企业 json 属性仅用于集合；递归规范化后按 RFC 8785 表示排序并去重。 */
function normalizeJsonSet(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeJsonSet);
    const unique = new Map(normalized.map((entry) => [rfc8785Canonicalize(entry), entry]));
    return [...unique.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJsonSet(entry)]),
    );
  }
  return value;
}
