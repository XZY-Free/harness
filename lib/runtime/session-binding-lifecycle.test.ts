/**
 * RuntimeSessionBinding 生命周期与匹配维度测试（06 §3-§4，Batch 7 Gate）。
 *
 * 覆盖：
 * - agentRevisionId 持久化（null = 基础 Harness Route）。
 * - findReusableSessionBinding 四维匹配：Tenant+Thread+AgentRevision+RuntimeRevision；
 *   任一维度不同不误复用；closed/lost 不复用（06 §3 关闭条件）。
 * - Turn completed 不是关闭条件（06 §3）：closeSessionBinding 只能显式调用生效，
 *   无任何 Turn 终态路径自动关闭（grep 层断言由 Architecture Gate 负责，这里断言语义）。
 * - ExecutionSubject wire 校验（06 §6-§7，纯函数）。
 */
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  closeSessionBinding,
  createSessionBinding,
  findReusableSessionBinding,
  markSessionBindingLost,
} from "@/lib/runtime/session-binding-queries";
import {
  A2A_EXECUTION_SUBJECT_METADATA_KEY,
  executionSubjectToA2AMetadata,
  isValidExecutionSubjectWire,
} from "@/lib/runtime/transport/execution-subject";
import { beforeEach, describe, expect, it } from "vitest";

async function setup() {
  const tenant = await ensureDefaultTenant();
  const { thread } = await createThread({
    tenantId: tenant.id,
    title: "session binding 测试",
    ownerUserId: tenant.id,
    actorId: tenant.id,
  });
  return { tenantId: tenant.id, threadId: thread.id };
}

describe("RuntimeSessionBinding（06 §3-§4）", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("createSessionBinding 持久化 agentRevisionId；null 表示基础 Harness Route", async () => {
    const { tenantId, threadId } = await setup();
    const withAgent = await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-1",
    });
    expect(withAgent.agentRevisionId).toBe("ar-1");
    expect(withAgent.bindingState).toBe("active");

    const basic = await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: null,
      threadId,
      externalSessionRef: "ctx-2",
    });
    expect(basic.agentRevisionId).toBeNull();
  });

  it("findReusableSessionBinding：四维全等命中（最近 active 优先）", async () => {
    const { tenantId, threadId } = await setup();
    await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-old",
    });
    await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-new",
    });
    const reusable = await findReusableSessionBinding({
      tenantId,
      threadId,
      agentRevisionId: "ar-1",
      runtimeRevisionId: "rr-1",
    });
    // createdAt 降序 → 最近一条。
    expect(reusable?.externalSessionRef).toBe("ctx-new");
  });

  it("findReusableSessionBinding：AgentRevision / RuntimeRevision / Thread 任一不同不误复用", async () => {
    const { tenantId, threadId } = await setup();
    const { thread: otherThread } = await createThread({
      tenantId,
      title: "另一会话",
      ownerUserId: tenantId,
      actorId: tenantId,
    });
    await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-1",
    });

    // AgentRevision 不同（含 null = 基础 Route）。
    expect(
      await findReusableSessionBinding({
        tenantId,
        threadId,
        agentRevisionId: "ar-2",
        runtimeRevisionId: "rr-1",
      }),
    ).toBeNull();
    expect(
      await findReusableSessionBinding({
        tenantId,
        threadId,
        agentRevisionId: null,
        runtimeRevisionId: "rr-1",
      }),
    ).toBeNull();
    // RuntimeRevision 不同。
    expect(
      await findReusableSessionBinding({
        tenantId,
        threadId,
        agentRevisionId: "ar-1",
        runtimeRevisionId: "rr-2",
      }),
    ).toBeNull();
    // Thread 不同。
    expect(
      await findReusableSessionBinding({
        tenantId,
        threadId: otherThread.id,
        agentRevisionId: "ar-1",
        runtimeRevisionId: "rr-1",
      }),
    ).toBeNull();
  });

  it("基础 Harness Route（双方 agentRevisionId=null）匹配", async () => {
    const { tenantId, threadId } = await setup();
    await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: null,
      threadId,
      externalSessionRef: "ctx-basic",
    });
    const reusable = await findReusableSessionBinding({
      tenantId,
      threadId,
      agentRevisionId: null,
      runtimeRevisionId: "rr-1",
    });
    expect(reusable?.externalSessionRef).toBe("ctx-basic");
  });

  it("closed / lost 不复用（06 §3：关闭条件后必须新会话）", async () => {
    const { tenantId, threadId } = await setup();
    const closed = await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-closed",
    });
    await closeSessionBinding(closed.id);
    expect(
      await findReusableSessionBinding({
        tenantId,
        threadId,
        agentRevisionId: "ar-1",
        runtimeRevisionId: "rr-1",
      }),
    ).toBeNull();

    const lost = await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-lost",
    });
    await markSessionBindingLost(lost.id);
    expect(
      await findReusableSessionBinding({
        tenantId,
        threadId,
        agentRevisionId: "ar-1",
        runtimeRevisionId: "rr-1",
      }),
    ).toBeNull();
  });

  it("Turn completed 不是关闭条件：closeSessionBinding 仅显式调用生效（幂等）", async () => {
    const { tenantId, threadId } = await setup();
    const binding = await createSessionBinding({
      tenantId,
      runtimeRevisionId: "rr-1",
      agentRevisionId: "ar-1",
      threadId,
      externalSessionRef: "ctx-keep",
    });
    // Turn 终态不触发关闭（06 §3）：无自动 close 路径，binding 保持 active 可复用。
    const reusable = await findReusableSessionBinding({
      tenantId,
      threadId,
      agentRevisionId: "ar-1",
      runtimeRevisionId: "rr-1",
    });
    expect(reusable?.id).toBe(binding.id);
    // 显式关闭幂等。
    const first = await closeSessionBinding(binding.id);
    expect(first.bindingState).toBe("closed");
    const second = await closeSessionBinding(binding.id);
    expect(second.bindingState).toBe("closed");
  });
});

describe("ExecutionSubject（06 §6-§7）", () => {
  it("isValidExecutionSubjectWire：合法 wire 通过；缺字段/类型错误拒绝", () => {
    expect(
      isValidExecutionSubjectWire({
        tenant_id: "t-1",
        subject_type: "user",
        subject_id: "u-1",
      }),
    ).toBe(true);
    expect(isValidExecutionSubjectWire(null)).toBe(false);
    expect(
      isValidExecutionSubjectWire({ tenant_id: "", subject_type: "user", subject_id: "u" }),
    ).toBe(false);
    expect(isValidExecutionSubjectWire({ tenant_id: "t", subject_type: 1, subject_id: "u" })).toBe(
      false,
    );
    expect(isValidExecutionSubjectWire({ tenant_id: "t", subject_type: "user" })).toBe(false);
  });

  it("executionSubjectToA2AMetadata：冻结 namespaced key，snake_case wire 形态", () => {
    expect(A2A_EXECUTION_SUBJECT_METADATA_KEY).toBe("snowharness.execution_subject");
    const value = executionSubjectToA2AMetadata({
      tenantId: "t-1",
      subjectType: "user",
      subjectId: "u-1",
    });
    expect(JSON.parse(value)).toEqual({
      tenant_id: "t-1",
      subject_type: "user",
      subject_id: "u-1",
    });
  });
});
