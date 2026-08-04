/**
 * CreateReplacementRuntimeRevision — 为历史 RuntimeRevision 创建替代版本。
 *
 * 复制字段：
 * - protocolType, endpointRef, identityMode, networkZone, runtimeCapabilitiesJson
 *
 * 重新计算：
 * - runtimeArtifactRef（来自 Evidence Service）
 * - configHash（由新 Artifact 和配置推导）
 * - protocolContractRevision
 *
 * 不复制：
 * - 旧 Artifact ID / Attestation / Conformance / Published 状态
 *
 * 新 Revision 随后走正式 Runtime 发布（attestationId + conformanceRunId 必填）。
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  runtimeRevisionTable,
  runtimeTable,
} from "@/lib/persistence/schema/control-plane";
import { protocolContractRevision } from "@/lib/runtimes/domain/runtime-conformance-run";
import { and, eq, max } from "drizzle-orm";

export interface ReplacementRuntimeRevisionResult {
  /** 新创建的 RuntimeRevision ID。 */
  replacementRevisionId: string;
  /** 新 Revision 的编号。 */
  replacementRevisionNo: number;
  /** 源 RuntimeRevision ID。 */
  sourceRevisionId: string;
  /** Runtime ID。 */
  runtimeId: string;
}

export interface CreateReplacementRuntimeRevisionCommand {
  tenantId: string;
  /** 源 RuntimeRevision ID（需要重新认证的历史版本）。 */
  sourceRevisionId: string;
  /** 来自 Evidence Service 的新 Artifact Ref。 */
  newArtifactRef: string;
  /** 创建者。 */
  createdBy: string;
}

export class ReplacementRuntimeRevisionSourceNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`源 RuntimeRevision 不存在: ${revisionId}`);
    this.name = "ReplacementRuntimeRevisionSourceNotFoundError";
  }
}

export class ReplacementRuntimeRevisionTenantMismatchError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly expectedTenantId: string,
  ) {
    super(`RuntimeRevision ${revisionId} 不属于租户 ${expectedTenantId}`);
    this.name = "ReplacementRuntimeRevisionTenantMismatchError";
  }
}

/**
 * 根据 Runtime 配置计算 Config Digest。
 *
 * 与 mysql-hosted-runtime-control-plane.ts 中的 digest() 逻辑一致，
 * 但接受已有字段而非从 Evidence Service 获取。
 */
function computeConfigDigest(params: {
  protocolType: string;
  endpointRef: string;
  capabilities: unknown;
  identityMode: string;
  networkZone: string;
}): string {
  const canonical = canonicalJson(params);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 创建 Replacement RuntimeRevision。
 *
 * 在事务内：
 * 1. 读取源 Revision 并验证 tenant
 * 2. FOR UPDATE 锁定 Runtime
 * 3. 分配新 revisionNo
 * 4. 插入新 draft Revision，复制稳定配置，重新计算 Digest
 */
export async function createReplacementRuntimeRevision(
  command: CreateReplacementRuntimeRevisionCommand,
): Promise<ReplacementRuntimeRevisionResult> {
  return db.transaction(async (tx) => {
    // 1. 读取源 Revision
    const [sourceRevision] = await tx
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, command.sourceRevisionId))
      .limit(1);

    if (!sourceRevision) {
      throw new ReplacementRuntimeRevisionSourceNotFoundError(command.sourceRevisionId);
    }

    // 2. 校验 tenant + 锁定 Runtime
    const [runtime] = await tx
      .select()
      .from(runtimeTable)
      .where(
        and(
          eq(runtimeTable.id, sourceRevision.runtimeId),
          eq(runtimeTable.tenantId, command.tenantId),
        ),
      )
      .limit(1)
      .for("update");

    if (!runtime) {
      throw new ReplacementRuntimeRevisionTenantMismatchError(
        command.sourceRevisionId,
        command.tenantId,
      );
    }

    // 3. 分配新 revisionNo
    const [sequence] = await tx
      .select({ value: max(runtimeRevisionTable.revisionNo) })
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.runtimeId, runtime.id));

    const replacementRevisionNo = (sequence?.value ?? 0) + 1;

    // 4. 重新计算 Config Digest 和 Protocol Contract Revision
    const configDigest = computeConfigDigest({
      protocolType: sourceRevision.protocolType,
      endpointRef: sourceRevision.endpointRef,
      capabilities: sourceRevision.runtimeCapabilitiesJson,
      identityMode: sourceRevision.identityMode,
      networkZone: sourceRevision.networkZone,
    });

    const newProtocolContractRevision = protocolContractRevision(
      sourceRevision.protocolType,
    );

    // 5. 创建新 draft Revision
    const replacementId = randomUUID();
    await tx.insert(runtimeRevisionTable).values({
      id: replacementId,
      runtimeId: runtime.id,
      revisionNo: replacementRevisionNo,
      protocolType: sourceRevision.protocolType,
      protocolContractRevision: newProtocolContractRevision,
      endpointRef: sourceRevision.endpointRef,
      runtimeArtifactRef: command.newArtifactRef,
      runtimeCapabilitiesJson: sourceRevision.runtimeCapabilitiesJson,
      identityMode: sourceRevision.identityMode,
      networkZone: sourceRevision.networkZone,
      configHash: configDigest,
      revisionState: "draft",
      createdBy: command.createdBy,
    });

    return {
      replacementRevisionId: replacementId,
      replacementRevisionNo,
      sourceRevisionId: command.sourceRevisionId,
      runtimeId: runtime.id,
    };
  });
}
