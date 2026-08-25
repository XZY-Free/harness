/**
 * AgentContractStore 契约与 MySQL 实现：Public Agent Contract 结构化快照的持久化。
 *
 * 事实源：Public Agent Contract 冻结目标模型（本切片）。
 *
 * 关键约束：
 * - 快照不可变：只提供 insert 与只读查询，不提供 update。
 * - header 查询一律租户限定；子记录读取按 position 升序（合同声明顺序），
 *   且必须在租户限定的 header 查得之后使用。
 * - list 最新优先，capturedAt 相同时以 id 降序做确定性 tie-break。
 */
import { db } from "@/lib/db/client";
import {
  type AgentContractCapabilityRow,
  type AgentContractInvocationContextRow,
  type AgentContractSnapshot,
  type AgentLifecycleState,
  type NewAgentContractCapabilityRow,
  type NewAgentContractInvocationContextRow,
  type NewAgentContractSnapshot,
  type NewAgentRow,
  agentContractCapabilityTable,
  agentContractInvocationContextTable,
  agentContractSnapshotTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import { and, asc, desc, eq } from "drizzle-orm";

export interface AgentContractStoreSession {
  /** 校验 Agent 存在且属于租户，并返回 agentKey（供身份匹配校验）。 */
  findAgent(
    tenantId: string,
    agentId: string,
  ): Promise<{ id: string; tenantId: string; agentKey: string } | null>;
  /**
   * 按 (tenantId, agentKey) 查找 Agent（agent-registrations 登记事务的 find-or-create 入口）。
   * 返回登记决策所需的稳定事实（owner/lifecycle/deletedAt）；租户限定。
   */
  findAgentByKey(
    tenantId: string,
    agentKey: string,
  ): Promise<AgentContractRegistrationTarget | null>;
  /** 在当前事务内插入新建的 draft Agent（禁止在事务外调用 createAgent 造成嵌套事务）。 */
  insertAgent(row: NewAgentRow): Promise<void>;
  /** 单事务写入 header + 全部有序子记录；任一失败整体回滚。 */
  insertContractSnapshot(
    header: NewAgentContractSnapshot,
    capabilities: NewAgentContractCapabilityRow[],
    contexts: NewAgentContractInvocationContextRow[],
  ): Promise<void>;
  /** 租户限定的快照 header 查询。 */
  findContractSnapshotById(
    tenantId: string,
    snapshotId: string,
  ): Promise<AgentContractSnapshot | null>;
  /** 该 Agent 的快照列表，最新优先（capturedAt desc, id desc tie-break）。 */
  listContractSnapshotsByAgent(tenantId: string, agentId: string): Promise<AgentContractSnapshot[]>;
  /** 租户限定并按 position 升序读 capability 子记录。 */
  listCapabilities(tenantId: string, snapshotId: string): Promise<AgentContractCapabilityRow[]>;
  /** 租户限定并按 position 升序读 invocation context 子记录。 */
  listInvocationContexts(
    tenantId: string,
    snapshotId: string,
  ): Promise<AgentContractInvocationContextRow[]>;
}

export interface AgentContractStore {
  transaction<T>(operation: (session: AgentContractStoreSession) => Promise<T>): Promise<T>;
}

/** 登记事务 find-or-create 的目标 Agent 稳定事实。 */
export interface AgentContractRegistrationTarget {
  id: string;
  tenantId: string;
  agentKey: string;
  displayName: string;
  ownerUserId: string;
  lifecycleState: AgentLifecycleState;
  deletedAt: Date | null;
}

export const mysqlAgentContractStore: AgentContractStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findAgent(tenantId, agentId) {
          const [agent] = await tx
            .select({
              id: agentTable.id,
              tenantId: agentTable.tenantId,
              agentKey: agentTable.agentKey,
            })
            .from(agentTable)
            .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
            .limit(1);
          return agent ?? null;
        },
        async findAgentByKey(tenantId, agentKey) {
          const [agent] = await tx
            .select({
              id: agentTable.id,
              tenantId: agentTable.tenantId,
              agentKey: agentTable.agentKey,
              displayName: agentTable.displayName,
              ownerUserId: agentTable.ownerUserId,
              lifecycleState: agentTable.lifecycleState,
              deletedAt: agentTable.deletedAt,
            })
            .from(agentTable)
            .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.agentKey, agentKey)))
            .limit(1);
          return agent ?? null;
        },
        async insertAgent(row) {
          await tx.insert(agentTable).values(row);
        },
        async insertContractSnapshot(header, capabilities, contexts) {
          await tx.insert(agentContractSnapshotTable).values(header);
          if (capabilities.length > 0) {
            await tx.insert(agentContractCapabilityTable).values(capabilities);
          }
          if (contexts.length > 0) {
            await tx.insert(agentContractInvocationContextTable).values(contexts);
          }
        },
        async findContractSnapshotById(tenantId, snapshotId) {
          const [row] = await tx
            .select()
            .from(agentContractSnapshotTable)
            .where(
              and(
                eq(agentContractSnapshotTable.tenantId, tenantId),
                eq(agentContractSnapshotTable.id, snapshotId),
              ),
            )
            .limit(1);
          return row ?? null;
        },
        async listContractSnapshotsByAgent(tenantId, agentId) {
          return tx
            .select()
            .from(agentContractSnapshotTable)
            .where(
              and(
                eq(agentContractSnapshotTable.tenantId, tenantId),
                eq(agentContractSnapshotTable.agentId, agentId),
              ),
            )
            .orderBy(
              desc(agentContractSnapshotTable.capturedAt),
              desc(agentContractSnapshotTable.id),
            );
        },
        async listCapabilities(tenantId, snapshotId) {
          return tx
            .select({ capability: agentContractCapabilityTable })
            .from(agentContractCapabilityTable)
            .innerJoin(
              agentContractSnapshotTable,
              eq(agentContractCapabilityTable.snapshotId, agentContractSnapshotTable.id),
            )
            .where(
              and(
                eq(agentContractSnapshotTable.tenantId, tenantId),
                eq(agentContractSnapshotTable.id, snapshotId),
              ),
            )
            .orderBy(asc(agentContractCapabilityTable.position))
            .then((rows) => rows.map((row) => row.capability));
        },
        async listInvocationContexts(tenantId, snapshotId) {
          return tx
            .select({ context: agentContractInvocationContextTable })
            .from(agentContractInvocationContextTable)
            .innerJoin(
              agentContractSnapshotTable,
              eq(agentContractInvocationContextTable.snapshotId, agentContractSnapshotTable.id),
            )
            .where(
              and(
                eq(agentContractSnapshotTable.tenantId, tenantId),
                eq(agentContractSnapshotTable.id, snapshotId),
              ),
            )
            .orderBy(asc(agentContractInvocationContextTable.position))
            .then((rows) => rows.map((row) => row.context));
        },
      }),
    ),
};
