/**
 * 进程内捕获型协议接收器（EventBatchSink）。
 *
 * 用于 Publication Conformance 隔离环境：注入到 createHostedAdapter 的
 * eventBatchSink，真实接收并保留候选事件供断言回读——不黑洞吞掉、不伪造 ack、
 * 不依赖外部 HTTP 端点。
 *
 * 仅测试/测试支持使用；生产代码禁止引用。
 */
import type { EventBatchSink } from "@/lib/runtime/adapters/hosted-adapter";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";

export interface CapturingEventBatchSink {
  sink: EventBatchSink;
  /** 累积接收到的全部真实候选事件。 */
  events: RuntimeCandidateEvent[];
  /** 单次 sink 调用记录（invocationId + producerSequenceStart）。 */
  calls: Array<{ invocationId: string; producerSequenceStart: number }>;
}

/** 创建进程内捕获型 EventBatchSink，接收并保留真实候选事件。 */
export function createCapturingEventBatchSink(): CapturingEventBatchSink {
  const events: RuntimeCandidateEvent[] = [];
  const calls: Array<{ invocationId: string; producerSequenceStart: number }> = [];
  const sink: EventBatchSink = async ({ invocationId, events: batch, producerSequenceStart }) => {
    events.push(...batch);
    calls.push({ invocationId, producerSequenceStart });
  };
  return { sink, events, calls };
}
