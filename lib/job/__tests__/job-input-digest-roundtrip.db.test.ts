/**
 * A10：Job 输入的摘要必须具有 **JSON 语义稳定性**。
 *
 * 审查报告指出的缺口：`createJob` 默认对输入直接 `JSON.stringify` 后 SHA256，再写入
 * MySQL JSON 列；Hosted 执行时 `jobInputDigest` 对数据库回读的对象再次直接
 * `JSON.stringify`，要求与原 `inputHash`、`Invocation.inputDigest` 全等。
 * MySQL 会在写入时规范化 JSON（按自身规则排序对象键、归一数字表示），对象属性插入
 * 顺序不是该列的稳定语义——于是**同一个合法对象经数据库 round-trip 后字节序改变
 * 就会被误判为输入篡改**（`InputDigestMismatch`）。
 *
 * 本文件在**真实 MySQL**上编码报告要求的验证清单：
 * 1. JOB-DIGEST-01：乱序多键 + 嵌套对象经真实 round-trip 后摘要仍稳定；
 *    并先证明 MySQL **确实**重排了键（否则这个用例根本没在考验规范化）。
 * 2. JOB-DIGEST-02：等价重复提交（`creationKey` 幂等）不冲突。
 * 3. JOB-DIGEST-03：真正修改值（标量 / 嵌套 / 数组顺序）仍必须冲突。
 * 4. JOB-DIGEST-04：运行时复验谓词（`assertJobInputDigestMatches`，Hosted
 *    `loadHostedExecutionSubject` 实际调用的那一个）在真实回读行上成立；
 *    行内输入被改写后必须拒绝。
 * 5. JOB-DIGEST-05：reference 输入的分支——内容摘要由创建方冻结，不经 JSON 规范化。
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { ALL_SUCCESS_COMPLETION_POLICY } from "@/lib/job/completion-policy";
import { admitQueuedJob } from "@/lib/job/job-admission";
import {
  JOB_INPUT_DIGEST_MISMATCH,
  assertJobInputDigestMatches,
  computeJobInputDigest,
} from "@/lib/job/job-input-digest";
import { createJob } from "@/lib/job/job-queries";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { jobTable } from "@/lib/persistence/schema/job";
import { ensureTenantWithBaselines } from "@/lib/test-support/ensure-tenant-with-baselines";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";
import { seedRuntimeRouteAuthority } from "@/lib/test-support/seed-runtime-route-authority";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

let TENANT_ID = "";

beforeEach(async () => {
  await resetDatabase(db);
  TENANT_ID = (await ensureDefaultTenant()).id;
});

/** 真实回读 Job 行（不是复用创建时的内存对象）。 */
async function readJob(jobId: string) {
  const [row] = await db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, TENANT_ID), eq(jobTable.id, jobId)))
    .limit(1);
  if (!row) throw new Error("Job 回读失败");
  return row;
}

function createInlineJob(input: { inputJson: unknown; creationKey?: string; triggerRef?: string }) {
  return createJob({
    tenantId: TENANT_ID,
    agentId: null,
    jobType: "batch",
    triggerRef: input.triggerRef ?? `trigger:${randomUUID()}`,
    ...(input.creationKey ? { creationKey: input.creationKey } : {}),
    completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
    inputJson: input.inputJson,
  });
}

/**
 * 建出可被 `admitQueuedJob` 真正解析的 Route/Runtime 权威。
 *
 * 与 `job-runtime.integration.test.ts` 的同名夹具同形：Job admission 会在事务内解析
 * 有效 Route 并冻结 Binding，没有生效路由时返回 `skipped/no_effective_route`。
 */
async function seedJobRuntimeAuthority(): Promise<string> {
  await ensureTenantWithBaselines(TENANT_ID, "job-digest-fixture");
  const identity = await upsertUserIdentity({
    tenantId: TENANT_ID,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const suffix = randomUUID().slice(0, 8);
  const { revision } = await seedPublishedRuntimeRevision(
    TENANT_ID,
    identity.id,
    `job-digest-${suffix}`,
    ["event_stream"],
    suffix,
  );
  await seedRuntimeRouteAuthority({
    tenantId: TENANT_ID,
    runtimeRevisionId: revision.id,
    actorId: "job-digest-fixture",
  });
  return revision.id;
}

/**
 * 刻意乱序的输入：顶层键、嵌套对象键、数组内的对象键全部与 MySQL 的规范顺序不同。
 *
 * MySQL 8 对 JSON 对象键按「键长度升序，再按字节序」排序，因此这些键在 round-trip
 * 后必然重排；数组元素顺序则被保留（数组顺序是 JSON 语义的一部分）。
 */
const UNSORTED_INPUT = {
  zeta: "z",
  alpha: { moons: [3, 1, 2], beta: true, alpha: 1 },
  beta: [{ y: 2, x: 1 }],
};

describe("A10：Job 输入摘要的 JSON 规范化稳定性（真实 MySQL round-trip）", () => {
  it("JOB-DIGEST-01: 乱序多键 + 嵌套对象经真实 round-trip 后摘要仍与冻结值一致", async () => {
    const { job } = await createInlineJob({ inputJson: UNSORTED_INPUT });
    const row = await readJob(job.id);

    // MySQL 确实规范化了 JSON —— 这是本用例真正在考验规范化算法的证据；
    // 若顺序恰好未变，下面的稳定性断言就毫无意义。
    expect(JSON.stringify(row.inputJson)).not.toBe(JSON.stringify(UNSORTED_INPUT));
    expect(Object.keys(row.inputJson as Record<string, unknown>)).not.toEqual(
      Object.keys(UNSORTED_INPUT),
    );
    expect(Object.keys((row.inputJson as { alpha: Record<string, unknown> }).alpha)).toEqual([
      "beta",
      "alpha",
      "moons",
    ]);
    // 数组顺序必须保留（否则就是改变了语义）。
    expect((row.inputJson as { alpha: { moons: number[] } }).alpha.moons).toEqual([3, 1, 2]);

    // 回读后的对象重算摘要，必须仍等于创建时冻结的 inputHash（旧实现会在这里开始分叉）。
    expect(row.inputHash).toBe(job.inputHash);
    expect(computeJobInputDigest(row.inputJson)).toBe(job.inputHash);

    // 同一语义、不同键序的内存对象也必须得到同一摘要。
    expect(
      computeJobInputDigest({
        beta: [{ x: 1, y: 2 }],
        alpha: { alpha: 1, moons: [3, 1, 2], beta: true },
        zeta: "z",
      }),
    ).toBe(job.inputHash);
  }, 30_000);

  it("JOB-DIGEST-02: 等价重复提交（同 creationKey、键序不同）是幂等重放而非冲突", async () => {
    const creationKey = `creation:${randomUUID()}`;
    const { job } = await createInlineJob({
      creationKey,
      inputJson: { b: 1, a: { y: 2, x: 3 } },
    });
    // 语义完全等价、键序不同（且与 MySQL 规范化后的顺序一致）的重复投递。
    const replayed = await createInlineJob({
      creationKey,
      inputJson: { a: { x: 3, y: 2 }, b: 1 },
    });

    expect(replayed.job.id).toBe(job.id);
    expect(replayed.job.inputHash).toBe(job.inputHash);

    const rows = await db
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, TENANT_ID), eq(jobTable.creationKey, creationKey)));
    expect(rows).toHaveLength(1);
    // 冻结的输入没有被重复投递改写。
    expect(rows[0]?.inputJson).toEqual({ b: 1, a: { y: 2, x: 3 } });
    expect(rows[0]?.inputHash).toBe(job.inputHash);
  }, 30_000);

  it("JOB-DIGEST-03: 真正修改值（标量 / 嵌套 / 数组顺序）仍必须冲突", async () => {
    const creationKey = `creation:${randomUUID()}`;
    const { job } = await createInlineJob({ creationKey, inputJson: { b: 1, a: { y: 2, x: 3 } } });

    // 顶层标量被改。
    await expect(
      createInlineJob({ creationKey, inputJson: { a: { x: 3, y: 2 }, b: 2 } }),
    ).rejects.toMatchObject({ name: JOB_INPUT_DIGEST_MISMATCH });
    // 嵌套值被改。
    await expect(
      createInlineJob({ creationKey, inputJson: { a: { x: 3, y: 4 }, b: 1 } }),
    ).rejects.toMatchObject({ name: JOB_INPUT_DIGEST_MISMATCH });
    // 字符串与数字不是同一语义。
    await expect(
      createInlineJob({ creationKey, inputJson: { a: { x: 3, y: 2 }, b: "1" } }),
    ).rejects.toMatchObject({ name: JOB_INPUT_DIGEST_MISMATCH });

    // 数组顺序是 JSON 语义的一部分：换序必须冲突（规范化保序）。
    const arrayKey = `creation:${randomUUID()}`;
    await createInlineJob({ creationKey: arrayKey, inputJson: { list: [1, 2] } });
    await expect(
      createInlineJob({ creationKey: arrayKey, inputJson: { list: [2, 1] } }),
    ).rejects.toMatchObject({ name: JOB_INPUT_DIGEST_MISMATCH });

    // 所有冲突都没有留下副作用：冻结输入原样。
    const row = await readJob(job.id);
    expect(row.inputJson).toEqual({ b: 1, a: { y: 2, x: 3 } });
    expect(row.inputHash).toBe(job.inputHash);
  }, 30_000);

  it("JOB-DIGEST-04: 运行时复验谓词在真实回读行上成立，行内输入被改写后必须拒绝", async () => {
    const { job } = await createInlineJob({ inputJson: UNSORTED_INPUT });
    await seedJobRuntimeAuthority();
    const admitted = await admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id });
    expect(admitted.outcome).toBe("admitted");
    if (admitted.outcome !== "admitted") return;
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, admitted.invocationId))
      .limit(1);
    if (!invocation) throw new Error("接纳后回读 Invocation 失败");
    expect(invocation.inputDigest).toBe(job.inputHash);

    // Hosted `loadHostedExecutionSubject` 执行的正是这个谓词。乱序键经 round-trip 后
    // 仍必须通过——旧实现会在这里抛 InputDigestMismatch。
    const row = await readJob(job.id);
    expect(
      assertJobInputDigestMatches({ job: row, invocationInputDigest: invocation.inputDigest }),
    ).toBe(row.inputHash);

    // ── 行内输入被真实改写：必须拒绝，且不得被"复算成自己"绕过 ──
    await db
      .update(jobTable)
      .set({ inputJson: { ...UNSORTED_INPUT, zeta: "tampered" } })
      .where(and(eq(jobTable.tenantId, TENANT_ID), eq(jobTable.id, job.id)));
    const tampered = await readJob(job.id);
    expect(() =>
      assertJobInputDigestMatches({ job: tampered, invocationInputDigest: invocation.inputDigest }),
    ).toThrow(JOB_INPUT_DIGEST_MISMATCH);

    // Invocation 侧冻结摘要被单独改动同样必须拒绝（两处冻结事实必须互相印证）。
    await db
      .update(jobTable)
      .set({ inputJson: UNSORTED_INPUT })
      .where(and(eq(jobTable.tenantId, TENANT_ID), eq(jobTable.id, job.id)));
    const restored = await readJob(job.id);
    expect(() =>
      assertJobInputDigestMatches({
        job: restored,
        invocationInputDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow(JOB_INPUT_DIGEST_MISMATCH);
  }, 30_000);

  it("JOB-DIGEST-05: reference 输入的内容摘要由创建方冻结，不经 JSON 规范化", async () => {
    const creationKey = `creation:${randomUUID()}`;
    const inputRef = `object://job-input/${randomUUID()}`;
    const frozenDigest = `sha256:${"a".repeat(64)}`;
    const { job } = await createJob({
      tenantId: TENANT_ID,
      agentId: null,
      jobType: "batch",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputRef,
      inputHash: frozenDigest,
    });
    const row = await readJob(job.id);
    expect(row.inputKind).toBe("reference");
    expect(row.inputJson).toBeNull();
    expect(row.inputHash).toBe(frozenDigest);

    // reference 分支的"复算"只能是冻结值本身 —— 定位符不含内容。
    expect(assertJobInputDigestMatches({ job: row, invocationInputDigest: frozenDigest })).toBe(
      frozenDigest,
    );

    // 同 Key 不同冻结摘要仍然冲突（完整性检查没有被 A10 的规范化改动削弱）。
    await expect(
      createJob({
        tenantId: TENANT_ID,
        agentId: null,
        jobType: "batch",
        triggerRef: `trigger:${randomUUID()}`,
        creationKey,
        completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
        inputRef,
        inputHash: `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ name: JOB_INPUT_DIGEST_MISMATCH });
  }, 30_000);
});
