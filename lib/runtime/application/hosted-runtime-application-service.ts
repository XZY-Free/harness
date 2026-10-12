import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";

export interface HostedRuntimeResumeResult {
  status: "handled_noop" | "resumed";
  invocationId: string;
  runtime?: "hosted" | "external";
  completed?: boolean;
  pending?: boolean;
  waitingForUser?: boolean;
}

interface HostedControlInput {
  tenantId: string;
  invocationId: string;
  idempotencyKey: string;
  /**
   * R02 §2：Hosted 控制入口必须携带 Start/Resume 的**准确 authority 与 Session
   * 启动身份**；应用层据此复核代际，不按 invocationId 重新加载当前 Owner。
   */
  authority: AuthorityIdentity;
}

/** Hosted Runtime 的正式本地应用边界；所有方法只接受 durable identity。 */
export interface HostedRuntimeApplicationService {
  start(input: HostedControlInput): Promise<HostedRuntimeResumeResult>;
  resume(
    input: HostedControlInput & { resumePayload?: unknown },
  ): Promise<HostedRuntimeResumeResult>;
  cancel(input: HostedControlInput & { reason?: string }): Promise<void>;
  steer(input: HostedControlInput & { steerPayload?: unknown }): Promise<void>;
}
