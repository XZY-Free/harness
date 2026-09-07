import { rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
/**
 * 企业用户完整快照同步。
 *
 * 该模块只消费已经由 EnterpriseUserAdapter 返回的完整快照，不包含任何
 * LDAP、PeopleSoft、SSO 或企业目录连接逻辑。同步入口是当前用户上下文建立前
 * 的唯一写路径；当前上下文内使用本次同步产生的可信结果。
 */
import { type DbOrTx, db } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/identity/audit";
import {
  ENTERPRISE_ATTRIBUTE_CATALOG,
  type EnterpriseAttributeKey,
  EnterpriseProfileValidationError,
  type EnterpriseUserProfileSnapshot,
  type JsonValue,
  type NormalizedEnterpriseUserProfile,
  computeEnterpriseProfileFingerprint,
  normalizeEnterpriseUserProfile,
} from "@/lib/identity/enterprise-user";
import {
  type EnterpriseUserAdapterContext,
  type EnterpriseUserAdapterSubject,
  type SelectedEnterpriseUserAdapter,
  getEnterpriseUserAdapter,
} from "@/lib/identity/enterprise-user-adapter";
import {
  type EnterpriseUserAttributeInput,
  deleteEnterpriseUserAttribute,
  getEnterpriseUserProfileFacts,
  upsertEnterpriseProfileSyncState,
  upsertEnterpriseUserAttribute,
} from "@/lib/identity/enterprise-user-profile-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  type UserExtensionAttribute,
  type UserIdentity,
  userIdentity,
} from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";

export type EnterpriseUserProfileStatus = "fresh" | "stale" | "unavailable" | "disabled";

export type EnterpriseUserSyncErrorCode =
  | "enterprise_adapter_unavailable"
  | "enterprise_profile_subject_mismatch"
  | "enterprise_profile_identity_mismatch"
  | "enterprise_profile_incomplete"
  | "enterprise_profile_source_invalid"
  | "enterprise_profile_status_invalid"
  | "enterprise_profile_attribute_unknown"
  | "enterprise_profile_attribute_type_invalid";

export interface EnterpriseUserSyncResult {
  userIdentity: UserIdentity;
  profileStatus: EnterpriseUserProfileStatus;
  lastVerifiedAt: Date | null;
  profileFingerprint: string | null;
  /** 已规范化的企业字段；权限与 dataScopes 仍只存在服务端上下文。 */
  attributes: NormalizedEnterpriseUserProfile["attributes"];
}

export class EnterpriseUserProfileSyncError extends Error {
  constructor(
    public readonly code: EnterpriseUserSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseUserProfileSyncError";
  }
}

export async function syncEnterpriseUserProfile(params: {
  subject: EnterpriseUserAdapterSubject;
  userIdentityId?: string;
  adapter?: SelectedEnterpriseUserAdapter;
  /** 认证链产生的可信 claims；仅传给 Adapter，不落库、不进审计、不进日志。 */
  trustedAuthenticationClaims?: Readonly<Record<string, unknown>>;
  now?: Date;
}): Promise<EnterpriseUserSyncResult> {
  const adapter = params.adapter ?? getEnterpriseUserAdapter();

  // 开源默认模式只使用标准身份体系，不伪造企业资料或同步元数据。
  if (adapter.kind === "default") {
    const identity = await readIdentity(params.subject.tenantId, params.subject.externalSubject);
    if (!identity || (params.userIdentityId && identity.id !== params.userIdentityId)) {
      throw new EnterpriseUserProfileSyncError(
        "enterprise_profile_identity_mismatch",
        "当前用户身份与标准身份映射不一致",
      );
    }
    return {
      userIdentity: identity,
      profileStatus: "unavailable",
      lastVerifiedAt: null,
      profileFingerprint: null,
      attributes: {},
    };
  }

  const adapterContext: EnterpriseUserAdapterContext = {
    subject: params.subject,
    trustedAuthenticationClaims: params.trustedAuthenticationClaims ?? {},
  };
  const adapterResult = await adapter.resolveUser(adapterContext);
  if (adapterResult.status === "unavailable") {
    return recordSyncUnavailable({
      ...params,
      code: "enterprise_adapter_unavailable",
      message: "企业用户适配器未提供当前可用资料",
    });
  }
  if (adapterResult.status === "stale") {
    return reuseLastKnownProfile(params);
  }

  const rawProfile: EnterpriseUserProfileSnapshot = adapterResult.profile;

  let profile: NormalizedEnterpriseUserProfile;
  try {
    profile = normalizeEnterpriseUserProfile(rawProfile);
  } catch (error) {
    if (error instanceof EnterpriseProfileValidationError) {
      return recordSyncUnavailable({
        ...params,
        code: error.code,
        message: "企业用户资料校验失败",
      });
    }
    throw error;
  }

  if (profile.externalSubject !== params.subject.externalSubject) {
    return recordSyncUnavailable({
      ...params,
      code: "enterprise_profile_subject_mismatch",
      message: "企业用户资料主体与可信认证主体不一致",
    });
  }

  const fingerprint = computeEnterpriseProfileFingerprint(profile);
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    const beforeIdentity = await readIdentity(
      params.subject.tenantId,
      params.subject.externalSubject,
      tx,
    );
    const identity = await upsertUserIdentity({
      tenantId: params.subject.tenantId,
      externalSubject: profile.externalSubject,
      email: profile.email,
      displayName: profile.displayName,
      status: profile.status,
      client: tx,
    });
    if (params.userIdentityId && identity.id !== params.userIdentityId) {
      throw new EnterpriseUserProfileSyncError(
        "enterprise_profile_identity_mismatch",
        "企业用户资料映射到了不一致的标准身份",
      );
    }

    const facts = await getEnterpriseUserProfileFacts(params.subject.tenantId, identity.id, tx);
    if (!facts) {
      throw new EnterpriseUserProfileSyncError(
        "enterprise_profile_identity_mismatch",
        "企业用户资料所属身份不存在或租户不一致",
      );
    }

    const changedKeys = changedIdentityKeys(beforeIdentity, identity);
    const incomingKeys = new Set(Object.keys(profile.attributes));
    for (const [attributeKey, value] of Object.entries(profile.attributes)) {
      const key = attributeKey as EnterpriseAttributeKey;
      if (!attributeRowMatches(facts.attributes, key, value)) changedKeys.push(key);
      await upsertEnterpriseUserAttribute(
        params.subject.tenantId,
        identity.id,
        toAttributeInput(key, value, profile.sourceSystem),
        tx,
      );
    }
    for (const existing of facts.attributes) {
      if (!incomingKeys.has(existing.attributeKey)) {
        changedKeys.push(existing.attributeKey as EnterpriseAttributeKey);
        await deleteEnterpriseUserAttribute(
          params.subject.tenantId,
          identity.id,
          existing.attributeKey,
          tx,
        );
      }
    }

    const previousState = facts.syncState;
    await upsertEnterpriseProfileSyncState(
      params.subject.tenantId,
      identity.id,
      {
        profileFingerprint: fingerprint,
        lastVerifiedAt: now,
        stale: false,
        lastSyncErrorCode: null,
        sourceSystem: profile.sourceSystem,
      },
      tx,
    );

    const actionType = successAuditAction({
      previousState,
      previousIdentity: beforeIdentity,
      currentIdentity: identity,
      fingerprint,
    });
    if (actionType) {
      await recordAuditEvent({
        actor: { tenantId: params.subject.tenantId, actorType: "user", actorId: identity.id },
        actionType,
        targetType: "user_identity",
        targetId: identity.id,
        reason: "企业用户资料同步",
        outcome: "succeeded",
        metadataRedacted: {
          sourceSystem: profile.sourceSystem,
          changedKeys: [...new Set(changedKeys)].sort(),
        },
        client: tx,
      });
    }

    return {
      userIdentity: identity,
      profileStatus: identity.status === "disabled" ? "disabled" : "fresh",
      lastVerifiedAt: now,
      profileFingerprint: fingerprint,
      attributes: profile.attributes,
    };
  });
}

async function recordSyncUnavailable(params: {
  subject: EnterpriseUserAdapterSubject;
  userIdentityId?: string;
  adapter?: SelectedEnterpriseUserAdapter;
  trustedAuthenticationClaims?: Readonly<Record<string, unknown>>;
  now?: Date;
  code: EnterpriseUserSyncErrorCode;
  message: string;
}): Promise<EnterpriseUserSyncResult> {
  const identity = await readIdentity(params.subject.tenantId, params.subject.externalSubject);
  if (!identity || (params.userIdentityId && identity.id !== params.userIdentityId)) {
    throw new EnterpriseUserProfileSyncError(
      "enterprise_profile_identity_mismatch",
      "企业资料同步失败且当前标准身份不存在",
    );
  }

  const facts = await getEnterpriseUserProfileFacts(params.subject.tenantId, identity.id);
  await db.transaction(async (tx) => {
    if (facts?.syncState) {
      await upsertEnterpriseProfileSyncState(
        params.subject.tenantId,
        identity.id,
        {
          profileFingerprint: facts.syncState.profileFingerprint,
          lastVerifiedAt: facts.syncState.lastVerifiedAt,
          stale: facts.syncState.stale,
          lastSyncErrorCode: params.code,
          sourceSystem: facts.syncState.sourceSystem,
        },
        tx,
      );
    }
    await recordAuditEvent({
      actor: { tenantId: params.subject.tenantId, actorType: "user", actorId: identity.id },
      actionType: "enterprise.user_profile.sync_failed",
      targetType: "user_identity",
      targetId: identity.id,
      reason: params.message,
      outcome: "failed",
      metadataRedacted: {
        sourceSystem: facts?.syncState?.sourceSystem ?? "unknown",
        errorCode: params.code,
        hadLastVerifiedProfile: Boolean(facts?.syncState),
      },
      client: tx,
    });
  });

  return {
    userIdentity: identity,
    profileStatus: identity.status === "disabled" ? "disabled" : "unavailable",
    lastVerifiedAt: facts?.syncState?.lastVerifiedAt ?? null,
    profileFingerprint: facts?.syncState?.profileFingerprint ?? null,
    attributes: {},
  };
}

/**
 * Adapter 明确允许复用最后一次成功资料时，Core 才能把请求标记为 stale 并投影旧字段。
 * 没有可复用事实时仍然 fail closed 为 unavailable，不能凭空制造企业资料。
 */
async function reuseLastKnownProfile(params: {
  subject: EnterpriseUserAdapterSubject;
  userIdentityId?: string;
  adapter?: SelectedEnterpriseUserAdapter;
  trustedAuthenticationClaims?: Readonly<Record<string, unknown>>;
  now?: Date;
}): Promise<EnterpriseUserSyncResult> {
  const identity = await readIdentity(params.subject.tenantId, params.subject.externalSubject);
  if (!identity || (params.userIdentityId && identity.id !== params.userIdentityId)) {
    throw new EnterpriseUserProfileSyncError(
      "enterprise_profile_identity_mismatch",
      "企业资料无法复用且当前标准身份不存在",
    );
  }

  const facts = await getEnterpriseUserProfileFacts(params.subject.tenantId, identity.id);
  const syncState = facts?.syncState;
  if (!syncState) {
    return recordSyncUnavailable({
      ...params,
      code: "enterprise_adapter_unavailable",
      message: "适配器允许复用资料，但当前用户没有最后成功资料",
    });
  }

  await db.transaction(async (tx) => {
    await upsertEnterpriseProfileSyncState(
      params.subject.tenantId,
      identity.id,
      {
        profileFingerprint: syncState.profileFingerprint,
        lastVerifiedAt: syncState.lastVerifiedAt,
        stale: true,
        lastSyncErrorCode: null,
        sourceSystem: syncState.sourceSystem,
      },
      tx,
    );
  });

  return {
    userIdentity: identity,
    profileStatus: identity.status === "disabled" ? "disabled" : "stale",
    lastVerifiedAt: syncState.lastVerifiedAt,
    profileFingerprint: syncState.profileFingerprint,
    attributes: attributesFromRows(facts.attributes),
  };
}

async function readIdentity(
  tenantId: string,
  externalSubject: string,
  client: DbOrTx = db,
): Promise<UserIdentity | null> {
  const [identity] = await client
    .select()
    .from(userIdentity)
    .where(
      and(eq(userIdentity.tenantId, tenantId), eq(userIdentity.externalSubject, externalSubject)),
    )
    .limit(1);
  return identity ?? null;
}

function changedIdentityKeys(before: UserIdentity | null, after: UserIdentity): string[] {
  if (!before) return ["email", "displayName", "status"];
  const changed: string[] = [];
  if (before.email !== after.email) changed.push("email");
  if (before.displayName !== after.displayName) changed.push("displayName");
  if (before.status !== after.status) changed.push("status");
  return changed;
}

function toAttributeInput(
  key: EnterpriseAttributeKey,
  value: string | number | boolean | JsonValue,
  sourceSystem: string,
): EnterpriseUserAttributeInput {
  return {
    attributeKey: key,
    valueType: ENTERPRISE_ATTRIBUTE_CATALOG[key].valueType,
    value,
    sourceSystem,
  };
}

function attributeRowMatches(
  rows: UserExtensionAttribute[],
  key: EnterpriseAttributeKey,
  value: string | number | boolean | JsonValue,
): boolean {
  const row = rows.find((candidate) => candidate.attributeKey === key);
  if (!row || row.valueType !== ENTERPRISE_ATTRIBUTE_CATALOG[key].valueType) return false;
  if (row.valueType === "string") return row.stringValue === value;
  if (row.valueType === "number") return Number(row.numberValue) === value;
  if (row.valueType === "boolean") return row.booleanValue === value;
  return rfc8785Canonicalize(row.jsonValue) === rfc8785Canonicalize(value);
}

export function attributesFromRows(
  rows: UserExtensionAttribute[],
): NormalizedEnterpriseUserProfile["attributes"] {
  const attributes: NormalizedEnterpriseUserProfile["attributes"] = {};
  for (const row of rows) {
    if (!(row.attributeKey in ENTERPRISE_ATTRIBUTE_CATALOG)) continue;
    const key = row.attributeKey as EnterpriseAttributeKey;
    if (row.valueType === "string" && row.stringValue !== null) attributes[key] = row.stringValue;
    if (row.valueType === "number" && row.numberValue !== null) {
      attributes[key] = Number(row.numberValue);
    }
    if (row.valueType === "boolean" && row.booleanValue !== null) {
      attributes[key] = row.booleanValue;
    }
    if (row.valueType === "json" && row.jsonValue !== null) {
      attributes[key] = row.jsonValue as JsonValue;
    }
  }
  return attributes;
}

function successAuditAction(params: {
  previousState: { profileFingerprint: string; stale: boolean } | null;
  previousIdentity: UserIdentity | null;
  currentIdentity: UserIdentity;
  fingerprint: string;
}):
  | "enterprise.user_profile.created"
  | "enterprise.user_profile.changed"
  | "enterprise.user_profile.fresh"
  | "enterprise.user.disabled"
  | null {
  if (!params.previousState) return "enterprise.user_profile.created";
  if (params.previousState.stale) return "enterprise.user_profile.fresh";
  if (
    params.currentIdentity.status === "disabled" &&
    params.previousIdentity?.status !== "disabled"
  ) {
    return "enterprise.user.disabled";
  }
  if (params.previousState.profileFingerprint !== params.fingerprint) {
    return "enterprise.user_profile.changed";
  }
  return null;
}
