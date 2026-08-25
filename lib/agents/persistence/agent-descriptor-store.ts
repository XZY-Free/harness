/**
 * AgentDescriptorStore 契约：不可变 AgentDescriptorSnapshot 的持久化接口。
 *
 * 事实源：docs/V12/01/agent补充/00 §6.2 / 01 §2。
 * Snapshot 登记后不可修改；本 store 只提供 insert 与只读查询，不提供 update。
 */
import type {
  AgentDescriptorSnapshot,
  NewAgentDescriptorSnapshot,
} from "@/lib/persistence/schema/agents";

export interface AgentDescriptorStoreSession {
  /** 校验 Agent 存在且属于租户（供登记命令做 fail-closed）。 */
  findAgent(tenantId: string, agentId: string): Promise<{ id: string; tenantId: string } | null>;
  /** 插入一个不可变 Snapshot。 */
  insertSnapshot(row: NewAgentDescriptorSnapshot): Promise<void>;
  findSnapshotById(id: string): Promise<AgentDescriptorSnapshot | null>;
  listSnapshotsByAgent(tenantId: string, agentId: string): Promise<AgentDescriptorSnapshot[]>;
}

export interface AgentDescriptorStore {
  transaction<T>(operation: (session: AgentDescriptorStoreSession) => Promise<T>): Promise<T>;
}
