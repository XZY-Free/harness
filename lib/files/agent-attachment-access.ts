import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import { getFileStorageProvider } from "@/lib/files/storage-bootstrap";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  workspaceAttachment,
  workspaceAttachmentAccessGrant,
  workspaceAttachmentUse,
} from "@/lib/persistence/schema/workspace";
import { and, eq, inArray, isNull } from "drizzle-orm";

const MAX_AGENT_ATTACHMENTS = 5;
const MAX_GRANT_TTL_MS = 5 * 60 * 1000;
const ATTACHMENT_CONTEXT_PREFIX = "attachment:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentAttachmentReference {
  reference_id: string;
  resource_type: "file";
  display_name: string;
  media_type: string;
}

export class AgentAttachmentAccessError extends Error {
  constructor(
    readonly code:
      | "selection_invalid"
      | "context_mismatch"
      | "attachment_unavailable"
      | "grant_expired"
      | "storage_unavailable"
      | "integrity_failed",
    message: string,
  ) {
    super(message);
    this.name = "AgentAttachmentAccessError";
  }
}

export interface CreateAgentAttachmentReferencesInput {
  tenantId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
  agentCallId: string;
  selectedContextRefs: readonly string[];
  expiresAt: Date;
  now?: Date;
}

/** 把 Harness action 显式选择的 attachment:<id> 转为短期公共引用。 */
export async function createAgentAttachmentReferences(
  input: CreateAgentAttachmentReferencesInput,
): Promise<AgentAttachmentReference[]> {
  const selectedIds = input.selectedContextRefs
    .filter((reference) => reference.startsWith(ATTACHMENT_CONTEXT_PREFIX))
    .map((reference) => reference.slice(ATTACHMENT_CONTEXT_PREFIX.length));
  if (selectedIds.length === 0) return [];
  if (
    selectedIds.length > MAX_AGENT_ATTACHMENTS ||
    new Set(selectedIds).size !== selectedIds.length
  ) {
    throw new AgentAttachmentAccessError("selection_invalid", "Agent 附件选择无效或超过 5 个");
  }
  if (selectedIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new AgentAttachmentAccessError("selection_invalid", "Agent 附件引用格式非法");
  }

  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(
      and(eq(invocationTable.tenantId, input.tenantId), eq(invocationTable.id, input.invocationId)),
    )
    .limit(1);
  const [call] = await db
    .select()
    .from(agentCallTable)
    .where(
      and(eq(agentCallTable.tenantId, input.tenantId), eq(agentCallTable.id, input.agentCallId)),
    )
    .limit(1);
  if (
    !invocation ||
    invocation.threadId !== input.threadId ||
    invocation.turnId !== input.turnId ||
    !call ||
    call.parentInvocationId !== input.invocationId
  ) {
    throw new AgentAttachmentAccessError("context_mismatch", "附件授权与执行上下文不一致");
  }

  const rows = await db
    .select({ attachment: workspaceAttachment })
    .from(workspaceAttachmentUse)
    .innerJoin(
      workspaceAttachment,
      and(
        eq(workspaceAttachment.id, workspaceAttachmentUse.workspaceAttachmentId),
        eq(workspaceAttachment.tenantId, workspaceAttachmentUse.tenantId),
      ),
    )
    .where(
      and(
        eq(workspaceAttachmentUse.tenantId, input.tenantId),
        eq(workspaceAttachmentUse.turnId, input.turnId),
        inArray(workspaceAttachmentUse.workspaceAttachmentId, selectedIds),
      ),
    );
  const byId = new Map(rows.map(({ attachment }) => [attachment.id, attachment]));
  const now = input.now ?? new Date();
  const expiresAt = new Date(Math.min(input.expiresAt.getTime(), now.getTime() + MAX_GRANT_TTL_MS));
  if (expiresAt.getTime() <= now.getTime()) {
    throw new AgentAttachmentAccessError("grant_expired", "附件授权期限已结束");
  }

  const references: AgentAttachmentReference[] = [];
  for (const attachmentId of selectedIds) {
    const attachment = byId.get(attachmentId);
    if (
      !attachment ||
      attachment.threadId !== input.threadId ||
      attachment.resourceType !== "file" ||
      attachment.attachmentState !== "attached" ||
      (attachment.expiresAt !== null && attachment.expiresAt.getTime() <= now.getTime()) ||
      !attachment.originalFilename ||
      !attachment.contentType ||
      attachment.sizeBytes === null
    ) {
      throw new AgentAttachmentAccessError(
        "attachment_unavailable",
        "附件未绑定当前 Turn 或当前不可用",
      );
    }

    let [grant] = await db
      .select()
      .from(workspaceAttachmentAccessGrant)
      .where(
        and(
          eq(workspaceAttachmentAccessGrant.tenantId, input.tenantId),
          eq(workspaceAttachmentAccessGrant.agentCallId, input.agentCallId),
          eq(workspaceAttachmentAccessGrant.workspaceAttachmentId, attachment.id),
        ),
      )
      .limit(1);
    if (!grant) {
      const grantId = randomUUID();
      try {
        await db.insert(workspaceAttachmentAccessGrant).values({
          id: grantId,
          tenantId: input.tenantId,
          workspaceAttachmentId: attachment.id,
          turnId: input.turnId,
          invocationId: input.invocationId,
          agentCallId: input.agentCallId,
          issuedAt: now,
          expiresAt,
        });
      } catch (error) {
        if (!isMysqlDuplicateEntryError(error)) throw error;
      }
      [grant] = await db
        .select()
        .from(workspaceAttachmentAccessGrant)
        .where(
          and(
            eq(workspaceAttachmentAccessGrant.tenantId, input.tenantId),
            eq(workspaceAttachmentAccessGrant.agentCallId, input.agentCallId),
            eq(workspaceAttachmentAccessGrant.workspaceAttachmentId, attachment.id),
          ),
        )
        .limit(1);
    }
    if (grant && (grant.turnId !== input.turnId || grant.invocationId !== input.invocationId)) {
      throw new AgentAttachmentAccessError("context_mismatch", "附件授权与执行上下文不一致");
    }
    if (!grant || grant.expiresAt.getTime() <= now.getTime() || grant.revokedAt !== null) {
      throw new AgentAttachmentAccessError("grant_expired", "附件授权已失效");
    }
    references.push({
      reference_id: grant.id,
      resource_type: "file",
      display_name: attachment.originalFilename,
      media_type: attachment.contentType,
    });
  }
  return references;
}

/** 解析短期公共引用，重新核对执行链和附件事实后读取原始字节。 */
export async function readAgentAttachment(referenceId: string, now: Date = new Date()) {
  const [row] = await db
    .select({
      grant: workspaceAttachmentAccessGrant,
      attachment: workspaceAttachment,
      call: agentCallTable,
      invocation: invocationTable,
    })
    .from(workspaceAttachmentAccessGrant)
    .innerJoin(
      workspaceAttachment,
      and(
        eq(workspaceAttachment.id, workspaceAttachmentAccessGrant.workspaceAttachmentId),
        eq(workspaceAttachment.tenantId, workspaceAttachmentAccessGrant.tenantId),
      ),
    )
    .innerJoin(
      agentCallTable,
      and(
        eq(agentCallTable.id, workspaceAttachmentAccessGrant.agentCallId),
        eq(agentCallTable.tenantId, workspaceAttachmentAccessGrant.tenantId),
      ),
    )
    .innerJoin(
      invocationTable,
      and(
        eq(invocationTable.id, workspaceAttachmentAccessGrant.invocationId),
        eq(invocationTable.tenantId, workspaceAttachmentAccessGrant.tenantId),
      ),
    )
    .where(
      and(
        eq(workspaceAttachmentAccessGrant.id, referenceId),
        isNull(workspaceAttachmentAccessGrant.revokedAt),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.grant.expiresAt.getTime() <= now.getTime() ||
    row.call.parentInvocationId !== row.grant.invocationId ||
    row.call.cancelRequestedAt !== null ||
    !["queued", "running", "waiting_user"].includes(row.call.state) ||
    row.invocation.threadId !== row.attachment.threadId ||
    row.invocation.turnId !== row.grant.turnId ||
    row.attachment.resourceType !== "file" ||
    row.attachment.attachmentState !== "attached" ||
    (row.attachment.expiresAt !== null && row.attachment.expiresAt.getTime() <= now.getTime()) ||
    !row.attachment.originalFilename ||
    !row.attachment.contentType ||
    row.attachment.sizeBytes === null ||
    !row.attachment.resourceFingerprint
  ) {
    throw new AgentAttachmentAccessError("attachment_unavailable", "附件引用不存在或不可用");
  }
  const [usage] = await db
    .select({ id: workspaceAttachmentUse.id })
    .from(workspaceAttachmentUse)
    .where(
      and(
        eq(workspaceAttachmentUse.tenantId, row.grant.tenantId),
        eq(workspaceAttachmentUse.turnId, row.grant.turnId),
        eq(workspaceAttachmentUse.workspaceAttachmentId, row.attachment.id),
      ),
    )
    .limit(1);
  if (!usage) {
    throw new AgentAttachmentAccessError("attachment_unavailable", "附件引用不存在或不可用");
  }

  const provider = await getFileStorageProvider();
  if (provider.name !== row.attachment.storageProvider) {
    throw new AgentAttachmentAccessError("storage_unavailable", "附件存储暂不可用");
  }
  const content = await provider.read({
    tenantId: row.grant.tenantId,
    threadId: row.attachment.threadId,
    resourceRef: row.attachment.resourceRef,
  });
  if (
    !content ||
    content.byteLength !== row.attachment.sizeBytes ||
    `sha256:${createHash("sha256").update(content).digest("hex")}` !==
      row.attachment.resourceFingerprint
  ) {
    throw new AgentAttachmentAccessError("integrity_failed", "附件原文件不存在或完整性校验失败");
  }
  return {
    content,
    originalFilename: row.attachment.originalFilename,
    contentType: row.attachment.contentType,
  };
}
