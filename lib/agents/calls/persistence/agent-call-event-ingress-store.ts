/**
 * AgentCallEventIngress Store — 仓储接口。
 *
 * 职责：对 Agent transport 回传事件做幂等接收（UNIQUE(callId, producerEventId) /
 * UNIQUE(callId, producerSequence)）。相同事件重复提交返回已存在；相同键不同 payload
 * hash 直接拒绝。
 */
import type { AgentCallEventIngress } from "@/lib/agents/calls/domain/agent-call-event-ingress";

export interface StoreAgentCallEventInput {
  id: string;
  callId: string;
  tenantId: string;
  producerEventId: string;
  producerSequence: number;
  candidateType: string;
  payloadHash: string;
  payloadJson: unknown;
  receivedAt: Date;
}

export type AcceptAgentCallEventResult =
  | { status: "accepted"; ingress: AgentCallEventIngress }
  | { status: "duplicate"; ingress: AgentCallEventIngress }
  | { status: "hash_conflict" };

export interface AgentCallEventIngressStore {
  /** 幂等接收：返回 accepted / duplicate / hash_conflict。 */
  accept(input: StoreAgentCallEventInput): Promise<AcceptAgentCallEventResult>;
  /** 标记为已归一化到 AgentCall state。 */
  markMapped(params: {
    ingressId: string;
    callId: string;
    tenantId: string;
    now: Date;
  }): Promise<AgentCallEventIngress>;
}
