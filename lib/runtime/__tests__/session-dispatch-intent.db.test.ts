/**
 * R02 §1 / §2 / §8：Session dispatch 意图的**持久幂等**与单向生命周期。
 *
 * 全部用真实 DB 事实断言（不 mock 仓储）：
 * 1. 同一语义请求重复派发（重试/重放）读回**原接纳**，不重新冻结、不判冲突；
 * 2. 同一命令 Key 但语义内容不同 → `StartIntentConflict`，已冻结事实不被改写；
 * 3. 语义域相同但 JSON 键序不同不算变化（冻结的是业务内容，不是序列化字节）；
 * 4. 迟到写入（`expectedVersionNo` 已前移）被拒绝；
 * 5. `lost`/`closed` 代际拒绝任何派发写入（单向生命周期，绝不回退）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
  markRuntimeSessionLostInTransaction,
  updateRuntimeSessionDispatchInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import { RuntimeSessionVersionConflictError } from "@/lib/runtime/persistence/runtime-session-store";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { beforeEach, describe, expect, it } from "vitest";

const SEMANTIC_A = { message: "hello", model: "kimi-k2.6" };
const DIGEST_A = protocolDigest(SEMANTIC_A);
const DIGEST_B = protocolDigest({ message: "changed", model: "kimi-k2.6" });

async function seedSession() {
  const tenant = await ensureDefaultTenant();
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const digest = protocolDigest({ runtimeId, runtimeRevisionId, fixture: "session-intent" });
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: tenant.id,
    runtimeKey: `session-intent-runtime-${runtimeId}`,
    displayName: "Session Intent Runtime",
    runtimeKind: "external",
    ownerUserId: "test-user",
    lifecycleState: "enabled",
    currentRevisionId: runtimeRevisionId,
    versionNo: 1,
  });
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    tenantId: tenant.id,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolVersion: 3,
    protocolContractDigest: digest,
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: digest,
    endpointRef: "http://127.0.0.1:9/reference-runtime",
    runtimeArtifactRef: null,
    artifactId: null,
    artifactDigest: null,
    runtimeCapabilitiesJson: defaultRuntimeCapabilities(),
    identityMode: "none",
    networkZone: "external",
    configHash: digest,
    credentialRefId: null,
    revisionState: "published",
    createdBy: "test-service",
  });
  const fixture = await seedPreparedRuntimeAttempt({
    tenantId: tenant.id,
    runtimeRevisionId,
  });
  const authority = await acquireTestRuntimeAuthority({
    tenantId: tenant.id,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId,
  });
  return { tenantId: tenant.id, fixture, authority };
}

function freezeIntent(tenantId: string, sessionBindingId: string, digest: string, json: unknown) {
  return db.transaction((tx) =>
    updateRuntimeSessionDispatchInTransaction(tx, {
      tenantId,
      id: sessionBindingId,
      patch: { semanticRequestJson: json, semanticRequestDigest: digest, lastErrorCode: null },
    }),
  );
}

describe("R02 §1/§2/§8 Session dispatch 意图持久幂等", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("SPI-01：同一语义请求重复派发读回原接纳，不重新冻结", async () => {
    const { tenantId, authority } = await seedSession();
    const first = await freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A);
    expect(first.semanticRequestDigest).toBe(DIGEST_A);
    expect(first.intentFrozenAt).not.toBeNull();
    expect(first.bindingState).toBe("dispatching");

    // 重试/重放：短期凭据、签名时间、连接等非语义域材料轮换后，语义内容不变。
    const repeated = await freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A);
    expect(repeated.semanticRequestDigest).toBe(DIGEST_A);
    expect(repeated.intentFrozenAt?.getTime()).toBe(first.intentFrozenAt?.getTime());
    expect(repeated.semanticRequestJson).toEqual(SEMANTIC_A);
  });

  it("SPI-02：同一命令 Key 不同语义内容 → StartIntentConflict，冻结事实不被改写", async () => {
    const { tenantId, authority } = await seedSession();
    const frozen = await freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A);

    await expect(
      freezeIntent(tenantId, authority.session.id, DIGEST_B, {
        message: "changed",
        model: "kimi-k2.6",
      }),
    ).rejects.toThrow("StartIntentConflict");

    const after = await db.transaction((tx) =>
      updateRuntimeSessionDispatchInTransaction(tx, {
        tenantId,
        id: authority.session.id,
        patch: { lastErrorCode: null },
      }),
    );
    expect(after.semanticRequestDigest).toBe(DIGEST_A);
    expect(after.semanticRequestJson).toEqual(SEMANTIC_A);
    expect(after.intentFrozenAt?.getTime()).toBe(frozen.intentFrozenAt?.getTime());
  });

  it("SPI-03：语义域相同而 JSON 键序不同不算变化（冻结业务内容，不冻结字节）", async () => {
    const { tenantId, authority } = await seedSession();
    await freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A);
    const reordered = { model: "kimi-k2.6", message: "hello" };

    const again = await freezeIntent(tenantId, authority.session.id, DIGEST_A, reordered);
    expect(again.semanticRequestDigest).toBe(DIGEST_A);
    expect(again.semanticRequestJson).toEqual(SEMANTIC_A);
  });

  it("SPI-04：迟到写入（版本已前移）被拒绝，不覆盖新代际结论", async () => {
    const { tenantId, authority } = await seedSession();
    const first = await freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A);
    const staleVersion = first.versionNo;
    // 竞争者先写入（ACK 单调合并），版本前移。
    await db.transaction((tx) =>
      updateRuntimeSessionDispatchInTransaction(tx, {
        tenantId,
        id: authority.session.id,
        patch: { remoteSessionRef: "remote-session-1" },
      }),
    );

    await expect(
      db.transaction((tx) =>
        updateRuntimeSessionDispatchInTransaction(tx, {
          tenantId,
          id: authority.session.id,
          expectedVersionNo: staleVersion,
          patch: { transportAcknowledgement: { accepted: true } },
        }),
      ),
    ).rejects.toBeInstanceOf(RuntimeSessionVersionConflictError);
  });

  it("SPI-05：lost 代际拒绝任何派发写入（单向生命周期，绝不回退）", async () => {
    const { tenantId, authority } = await seedSession();
    await freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A);
    await db.transaction((tx) =>
      markRuntimeSessionLostInTransaction(tx, { tenantId, id: authority.session.id }),
    );

    await expect(
      freezeIntent(tenantId, authority.session.id, DIGEST_A, SEMANTIC_A),
    ).rejects.toThrow(/RuntimeSessionMismatch/);
  });
});
