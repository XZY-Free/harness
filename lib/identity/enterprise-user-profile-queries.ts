/**
 * 企业用户当前资料的生产读写边界。
 *
 * 所有访问先校验 userIdentity 属于 tenant，再读写扩展属性或同步元数据。
 * 该模块不调用企业目录；它只持久化已经由适配器验证过的可信事实。
 */
import { randomUUID } from "node:crypto";

import { type DbOrTx, db } from "@/lib/db/client";
import type { JsonValue } from "@/lib/identity/enterprise-user";
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

/** 读取当前企业资料；不存在身份时返回 null，跨租户不暴露存在性。 */
export async function getEnterpriseUserProfileFacts(
  tenantId: string,
  userIdentityId: string,
  client: DbOrTx = db,
): Promise<EnterpriseUserProfileFacts | null> {
  const [identity] = await client
    .select({ id: userIdentity.id })
    .from(userIdentity)
    .where(and(eq(userIdentity.id, userIdentityId), eq(userIdentity.tenantId, tenantId)))
    .limit(1);
  if (!identity) return null;

  const [attributes, syncState] = await Promise.all([
    client
      .select()
      .from(userExtensionAttribute)
      .where(eq(userExtensionAttribute.userIdentityId, userIdentityId)),
    getEnterpriseProfileSyncState(tenantId, userIdentityId, client),
  ]);
  return { attributes, syncState };
}

/** 按租户读取同步元数据。 */
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
    stale: boolean;
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
