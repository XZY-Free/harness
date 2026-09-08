/**
 * 企业用户当前资料的生产读写边界。
 *
 * 所有访问先校验 userIdentity 属于 tenant，再读写扩展属性或同步元数据。
 * 该模块不调用企业目录；它只持久化已经由适配器验证过的可信事实。
 */
import { randomUUID } from "node:crypto";

import { type DbOrTx, db } from "@/lib/db/client";
import {
  ENTERPRISE_ATTRIBUTE_CATALOG,
  type EnterpriseAttributeKey,
  type JsonValue,
  type NormalizedEnterpriseUserProfile,
} from "@/lib/identity/enterprise-user";
import {
  type EnterpriseAttributeValueType,
  type EnterpriseProfileSyncState,
  type NewUserExtensionAttribute,
  type UserExtensionAttribute,
  enterpriseProfileSyncState,
  userExtensionAttribute,
  userIdentity,
} from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";

/**
 * 已开启事务的类型。组合快照读取只接受事务边界，绝不接受全局 db 池；
 * 需要通读整份事实的调用方必须拥有事务并在其上调用事务助手。
 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EnterpriseUserAttributeValue = string | number | boolean | JsonValue;

export interface EnterpriseUserAttributeInput {
  attributeKey: string;
  valueType: EnterpriseAttributeValueType;
  value: EnterpriseUserAttributeValue;
  sourceSystem: string;
}

export interface EnterpriseUserProfileFacts {
  attributes: UserExtensionAttribute[];
  syncState: EnterpriseProfileSyncState | null;
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

/** 在指定租户内确认 userIdentity 存在，避免扩展表成为跨租户旁路。 */
async function assertTenantUser(
  tenantId: string,
  userIdentityId: string,
  client: DbOrTx = db,
): Promise<void> {
  const [identity] = await client
    .select({ id: userIdentity.id })
    .from(userIdentity)
    .where(and(eq(userIdentity.id, userIdentityId), eq(userIdentity.tenantId, tenantId)))
    .limit(1);
  if (!identity) {
    throw new Error("企业用户资料所属身份不存在或不属于当前租户");
  }
}

/**
 * 读取当前企业资料的完整快照（公共入口，自持短事务）。
 *
 * 在事务内以当前读 FOR SHARE 锁定精确的 (tenantId, userIdentityId) UserIdentity，
 * 再于同一事务内顺序读取属性与同步元数据，保证 "完整 A 或完整 B" 的原子可见性。
 * 不存在身份时返回 null，跨租户不暴露存在性。
 */
export async function getEnterpriseUserProfileFacts(
  tenantId: string,
  userIdentityId: string,
): Promise<EnterpriseUserProfileFacts | null> {
  return db.transaction((tx) =>
    getEnterpriseUserProfileFactsInTransaction(tx, tenantId, userIdentityId),
  );
}

/**
 * 事务内读取完整资料快照。调用方必须已拥有事务（且通常已锁定 UserIdentity）。
 * 本函数在同一事务内以当前读 FOR SHARE 再确认/锁定 UserIdentity，再顺序读取属性与同步元数据，
 * 绝不使用全局 db。返回 null 时不暴露跨租户存在性。
 */
export async function getEnterpriseUserProfileFactsInTransaction(
  tx: DbTransaction,
  tenantId: string,
  userIdentityId: string,
): Promise<EnterpriseUserProfileFacts | null> {
  // 同事务已持有 FOR UPDATE 时，兼容地再取 OF SHARE 是安全的（锁已被本事务拥有）。
  const [identity] = await tx
    .select({ id: userIdentity.id })
    .from(userIdentity)
    .where(and(eq(userIdentity.id, userIdentityId), eq(userIdentity.tenantId, tenantId)))
    .for("share")
    .limit(1);
  if (!identity) return null;

  const attributes = await tx
    .select()
    .from(userExtensionAttribute)
    .where(eq(userExtensionAttribute.userIdentityId, userIdentityId))
    .for("share");

  const syncState = await getEnterpriseProfileSyncStateInTransaction(tx, tenantId, userIdentityId);
  return { attributes, syncState };
}

/** 事务内当前读单份同步元数据；保持租户/身份校验，不使用全局 db。 */
async function getEnterpriseProfileSyncStateInTransaction(
  tx: DbTransaction,
  tenantId: string,
  userIdentityId: string,
): Promise<EnterpriseProfileSyncState | null> {
  const [identity] = await tx
    .select({ id: userIdentity.id })
    .from(userIdentity)
    .where(and(eq(userIdentity.id, userIdentityId), eq(userIdentity.tenantId, tenantId)))
    .for("share")
    .limit(1);
  if (!identity) return null;

  const [state] = await tx
    .select()
    .from(enterpriseProfileSyncState)
    .where(eq(enterpriseProfileSyncState.userIdentityId, userIdentityId))
    .for("share")
    .limit(1);
  return state ?? null;
}

/** 按租户读取同步元数据（纯技术读取，不承诺组合快照）。 */
export async function getEnterpriseProfileSyncState(
  tenantId: string,
  userIdentityId: string,
  client: DbOrTx = db,
): Promise<EnterpriseProfileSyncState | null> {
  const [identity] = await client
    .select({ id: userIdentity.id })
    .from(userIdentity)
    .where(and(eq(userIdentity.id, userIdentityId), eq(userIdentity.tenantId, tenantId)))
    .limit(1);
  if (!identity) return null;

  const [state] = await client
    .select()
    .from(enterpriseProfileSyncState)
    .where(eq(enterpriseProfileSyncState.userIdentityId, userIdentityId))
    .limit(1);
  return state ?? null;
}

/**
 * 写入一项当前扩展事实。更新只发生在值或来源改变时；不做全量删除重建。
 */
export async function upsertEnterpriseUserAttribute(
  tenantId: string,
  userIdentityId: string,
  input: EnterpriseUserAttributeInput,
  client: DbOrTx = db,
): Promise<UserExtensionAttribute> {
  await assertTenantUser(tenantId, userIdentityId, client);
  const slots = attributeValueSlots(input.valueType, input.value);
  const [existing] = await client
    .select()
    .from(userExtensionAttribute)
    .where(
      and(
        eq(userExtensionAttribute.userIdentityId, userIdentityId),
        eq(userExtensionAttribute.attributeKey, input.attributeKey),
      ),
    )
    .limit(1);

  if (existing) {
    const changed =
      existing.valueType !== input.valueType ||
      existing.stringValue !== slots.stringValue ||
      existing.numberValue !== slots.numberValue ||
      existing.booleanValue !== slots.booleanValue ||
      JSON.stringify(existing.jsonValue) !== JSON.stringify(slots.jsonValue) ||
      existing.sourceSystem !== input.sourceSystem;
    if (changed) {
      const update: Partial<NewUserExtensionAttribute> = {
        stringValue: slots.stringValue,
        numberValue: slots.numberValue,
        booleanValue: slots.booleanValue,
        jsonValue: slots.jsonValue,
        valueType: input.valueType,
        sourceSystem: input.sourceSystem,
        updatedAt: new Date(),
      };
      await client
        .update(userExtensionAttribute)
        .set(update)
        .where(eq(userExtensionAttribute.id, existing.id));
    }
    const [updated] = await client
      .select()
      .from(userExtensionAttribute)
      .where(eq(userExtensionAttribute.id, existing.id))
      .limit(1);
    if (!updated) throw new Error("企业用户扩展属性更新后无法读取");
    return updated;
  }

  const id = randomUUID();
  const insert: NewUserExtensionAttribute = {
    id,
    userIdentityId,
    attributeKey: input.attributeKey,
    valueType: input.valueType,
    stringValue: slots.stringValue,
    numberValue: slots.numberValue,
    booleanValue: slots.booleanValue,
    jsonValue: slots.jsonValue,
    sourceSystem: input.sourceSystem,
  };
  await client.insert(userExtensionAttribute).values(insert);
  const [created] = await client
    .select()
    .from(userExtensionAttribute)
    .where(eq(userExtensionAttribute.id, id))
    .limit(1);
  if (!created) throw new Error("企业用户扩展属性创建后无法读取");
  return created;
}

/** 删除完整快照中已经消失的当前扩展事实。 */
export async function deleteEnterpriseUserAttribute(
  tenantId: string,
  userIdentityId: string,
  attributeKey: string,
  client: DbOrTx = db,
): Promise<void> {
  await assertTenantUser(tenantId, userIdentityId, client);
  await client
    .delete(userExtensionAttribute)
    .where(
      and(
        eq(userExtensionAttribute.userIdentityId, userIdentityId),
        eq(userExtensionAttribute.attributeKey, attributeKey),
      ),
    );
}

/** 创建或更新用户唯一的当前资料同步元数据。 */
export async function upsertEnterpriseProfileSyncState(
  tenantId: string,
  userIdentityId: string,
  input: {
    profileFingerprint: string;
    lastVerifiedAt: Date;
    freshUntil: Date;
    staleUntil: Date;
    lastSyncErrorCode: string | null;
    sourceSystem: string;
  },
  client: DbOrTx = db,
): Promise<EnterpriseProfileSyncState> {
  await assertTenantUser(tenantId, userIdentityId, client);
  const [existing] = await client
    .select()
    .from(enterpriseProfileSyncState)
    .where(eq(enterpriseProfileSyncState.userIdentityId, userIdentityId))
    .limit(1);
  if (existing) {
    await client
      .update(enterpriseProfileSyncState)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(enterpriseProfileSyncState.id, existing.id));
    const [updated] = await client
      .select()
      .from(enterpriseProfileSyncState)
      .where(eq(enterpriseProfileSyncState.id, existing.id))
      .limit(1);
    if (!updated) throw new Error("企业资料同步元数据更新后无法读取");
    return updated;
  }

  const id = randomUUID();
  await client.insert(enterpriseProfileSyncState).values({ id, userIdentityId, ...input });
  const [created] = await client
    .select()
    .from(enterpriseProfileSyncState)
    .where(eq(enterpriseProfileSyncState.id, id))
    .limit(1);
  if (!created) throw new Error("企业资料同步元数据创建后无法读取");
  return created;
}

/** 只记录本次失败分类；不得把旧成功资料重新整行写回。 */
export async function recordEnterpriseProfileSyncFailure(
  tenantId: string,
  userIdentityId: string,
  errorCode: string,
  client: DbOrTx = db,
): Promise<void> {
  await assertTenantUser(tenantId, userIdentityId, client);
  await client
    .update(enterpriseProfileSyncState)
    .set({ lastSyncErrorCode: errorCode, updatedAt: new Date() })
    .where(eq(enterpriseProfileSyncState.userIdentityId, userIdentityId));
}

function attributeValueSlots(
  valueType: EnterpriseAttributeValueType,
  value: EnterpriseUserAttributeValue,
): {
  stringValue: string | null;
  numberValue: string | null;
  booleanValue: boolean | null;
  jsonValue: JsonValue | null;
} {
  if (valueType === "string" && typeof value === "string" && value.trim().length > 0) {
    return { stringValue: value.trim(), numberValue: null, booleanValue: null, jsonValue: null };
  }
  if (valueType === "number" && typeof value === "number" && Number.isFinite(value)) {
    return {
      stringValue: null,
      numberValue: String(value),
      booleanValue: null,
      jsonValue: null,
    };
  }
  if (valueType === "boolean" && typeof value === "boolean") {
    return { stringValue: null, numberValue: null, booleanValue: value, jsonValue: null };
  }
  if (valueType === "json" && value !== null && typeof value === "object") {
    return { stringValue: null, numberValue: null, booleanValue: null, jsonValue: value };
  }
  throw new Error(`企业扩展属性 ${valueType} 值类型非法`);
}
