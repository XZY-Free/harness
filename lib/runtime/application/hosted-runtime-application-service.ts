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
