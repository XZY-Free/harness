import type { ResumeHarnessInvocationResult } from "./resume-harness-invocation";

interface HostedControlInput {
  tenantId: string;
  invocationId: string;
  idempotencyKey: string;
}

/** Hosted Runtime 的正式本地应用边界；所有方法只接受 durable identity。 */
export interface HostedRuntimeApplicationService {
  start(input: HostedControlInput): Promise<ResumeHarnessInvocationResult>;
  resume(
    input: HostedControlInput & { resumePayload?: unknown },
  ): Promise<ResumeHarnessInvocationResult>;
  cancel(input: HostedControlInput & { reason?: string }): Promise<void>;
  steer(input: HostedControlInput & { steerPayload?: unknown }): Promise<void>;
}
