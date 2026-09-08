import { db } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/identity/audit";
import {
  type EnterpriseProfileObservation,
  type EnterpriseProfileSource,
  validateEnterpriseProfileObservation,
} from "@/lib/identity/enterprise-profile-source";
import {
  ENTERPRISE_ATTRIBUTE_CATALOG,
  type EnterpriseAttributeKey,
  computeEnterpriseProfileFingerprint,
} from "@/lib/identity/enterprise-user";
import {
  type DbTransaction,
  deleteEnterpriseUserAttribute,
  getEnterpriseUserProfileFactsInTransaction,
  upsertEnterpriseProfileSyncState,
  upsertEnterpriseUserAttribute,
} from "@/lib/identity/enterprise-user-profile-queries";
import { userIdentity } from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";

export class EnterpriseProfileAcceptanceError extends Error {
  constructor(
    public readonly code:
      | "observation_invalid"
      | "subject_mismatch"
      | "deadline_extension_forbidden"
      | "identity_missing",
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseProfileAcceptanceError";
  }
}

export interface AcceptedEnterpriseProfile {
  readonly profileFingerprint: string;
  readonly freshUntil: Date;
  readonly staleUntil: Date;
}

/** 可信预期主体：必须由已认证证据 + Core 映射身份派生，绝不来自观察/请求体。 */
export interface TrustedEnterpriseSubject {
  readonly tenantId: string;
  readonly userIdentityId: string;
  readonly externalSubject: string;
}

export async function acceptEnterpriseProfileObservation(params: {
  observation: EnterpriseProfileObservation;
  source: EnterpriseProfileSource;
  expectedSubject: TrustedEnterpriseSubject;
  now?: Date;
  client?: DbTransaction;
}): Promise<AcceptedEnterpriseProfile> {
  let observation: ReturnType<typeof validateEnterpriseProfileObservation>;
  try {
    observation = validateEnterpriseProfileObservation(
      params.observation,
      params.source,
      params.now ?? new Date(),
    );
  } catch (error) {
    throw new EnterpriseProfileAcceptanceError(
      "observation_invalid",
      error instanceof Error ? error.message : "企业资料观察无效",
    );
  }

  // 观察必须锚定到可信预期主体：观察自报 tenantId/externalSubject 不能决定写入目标。
  // 校验在任何企业属性/同步元数据/审计写入之前完成。
  if (
    observation.tenantId !== params.expectedSubject.tenantId ||
    observation.externalSubject !== params.expectedSubject.externalSubject
  ) {
    throw new EnterpriseProfileAcceptanceError(
      "subject_mismatch",
      "企业资料观察与预期可信主体不一致",
    );
  }

  const execute = async (tx: DbTransaction): Promise<AcceptedEnterpriseProfile> => {
    // 只按可信预期主体定位/锁定 UserIdentity，绝不用观察自报主体做目标选择。
    const [identity] = await tx
      .select()
      .from(userIdentity)
      .where(
        and(
          eq(userIdentity.tenantId, params.expectedSubject.tenantId),
          eq(userIdentity.id, params.expectedSubject.userIdentityId),
        ),
      )
      .for("update")
      .limit(1);
    if (!identity) {
      throw new EnterpriseProfileAcceptanceError(
        "identity_missing",
        "企业资料观察对应的预期主体不存在",
      );
    }
    if (identity.externalSubject !== params.expectedSubject.externalSubject) {
      throw new EnterpriseProfileAcceptanceError(
        "subject_mismatch",
        "企业资料观察与预期主体的标准身份不一致",
      );
    }

    const fingerprint = computeEnterpriseProfileFingerprint({
      tenantId: observation.tenantId,
      userIdentityId: identity.id,
      externalSubject: observation.externalSubject,
      sourceSystem: observation.sourceSystem,
      attributes: observation.attributes,
    });
    const facts = await getEnterpriseUserProfileFactsInTransaction(
      tx,
      observation.tenantId,
      identity.id,
    );
    const previous = facts?.syncState;
    if (
      previous &&
      previous.profileFingerprint === fingerprint &&
      previous.lastVerifiedAt.getTime() === observation.verifiedAt.getTime()
    ) {
      if (
        observation.freshUntil.getTime() > previous.freshUntil.getTime() ||
        observation.staleUntil.getTime() > previous.staleUntil.getTime()
      ) {
        throw new EnterpriseProfileAcceptanceError(
          "deadline_extension_forbidden",
          "相同企业资料观察不能延长期限",
        );
      }
      if (
        observation.freshUntil.getTime() === previous.freshUntil.getTime() &&
        observation.staleUntil.getTime() === previous.staleUntil.getTime()
      ) {
        return {
          profileFingerprint: previous.profileFingerprint,
          freshUntil: previous.freshUntil,
          staleUntil: previous.staleUntil,
        };
      }
    }

    const incomingKeys = new Set(Object.keys(observation.attributes));
    const changedKeys: string[] = [];
    for (const [attributeKey, value] of Object.entries(observation.attributes)) {
      const key = attributeKey as EnterpriseAttributeKey;
      const descriptor = ENTERPRISE_ATTRIBUTE_CATALOG[key];
      const existing = facts?.attributes.find((row) => row.attributeKey === key);
      if (!existing || existing.valueType !== descriptor.valueType) changedKeys.push(key);
      await upsertEnterpriseUserAttribute(
        observation.tenantId,
        identity.id,
        {
          attributeKey: key,
          valueType: descriptor.valueType,
          value,
          sourceSystem: observation.sourceSystem,
        },
        tx,
      );
    }
    for (const existing of facts?.attributes ?? []) {
      if (!incomingKeys.has(existing.attributeKey)) {
        changedKeys.push(existing.attributeKey);
        await deleteEnterpriseUserAttribute(
          observation.tenantId,
          identity.id,
          existing.attributeKey,
          tx,
        );
      }
    }
    await upsertEnterpriseProfileSyncState(
      observation.tenantId,
      identity.id,
      {
        profileFingerprint: fingerprint,
        lastVerifiedAt: observation.verifiedAt,
        freshUntil: observation.freshUntil,
        staleUntil: observation.staleUntil,
        lastSyncErrorCode: null,
        sourceSystem: observation.sourceSystem,
      },
      tx,
    );
    if (!previous || changedKeys.length > 0 || previous.profileFingerprint !== fingerprint) {
      await recordAuditEvent({
        actor: { tenantId: observation.tenantId, actorType: "user", actorId: identity.id },
        actionType: previous
          ? "enterprise.user_profile.changed"
          : "enterprise.user_profile.created",
        targetType: "user_identity",
        targetId: identity.id,
        reason: "接纳企业资料观察",
        outcome: "succeeded",
        metadataRedacted: {
          sourceSystem: observation.sourceSystem,
          changedKeys: [...new Set(changedKeys)].sort(),
        },
        client: tx,
      });
    }
    return {
      profileFingerprint: fingerprint,
      freshUntil: observation.freshUntil,
      staleUntil: observation.staleUntil,
    };
  };

  return params.client ? execute(params.client) : db.transaction(execute);
}
