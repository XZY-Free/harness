import type { RuntimeConformanceReport } from "@/lib/runtime/domain/runtime-conformance-run";
import type {
  RuntimeConformanceCaseResultRecord,
  RuntimeConformanceRunRecord,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";

export interface RuntimeConformanceRevisionBinding {
  id: string;
  revisionState: "draft" | "published" | "withdrawn";
  /** Conformance 被测对象统一 digest。 */
  runtimeTargetDigest: string;
  artifactDigest: string | null;
  configHash: string;
  protocolContractRevision: string;
}

export interface RuntimeConformanceRunStore {
  findByIdempotency(params: {
    tenantId: string;
    runtimeRevisionId: string;
    idempotencyKey: string;
  }): Promise<{
    run: RuntimeConformanceRunRecord;
    caseResults: RuntimeConformanceCaseResultRecord[];
  } | null>;
  transaction<T>(operation: (session: RuntimeConformanceRunSession) => Promise<T>): Promise<T>;
}

export interface RuntimeConformanceRunSession {
  findRevision(
    tenantId: string,
    runtimeRevisionId: string,
  ): Promise<RuntimeConformanceRevisionBinding | null>;
  appendRun(params: {
    tenantId: string;
    report: RuntimeConformanceReport;
    verification: {
      envelopeDigest: string;
      envelopeJson: string;
      payloadDigest: string;
      signingKeyId: string;
      runnerIdentity: string;
      verificationEngine: string;
      verificationEngineVersion: string;
      predicateType: string;
      verifiedAt: Date;
    };
    idempotencyKey: string;
    requestId: string;
    recordedAt: Date;
  }): Promise<RuntimeConformanceRunRecord>;
  appendCaseResults(
    report: RuntimeConformanceReport,
  ): Promise<RuntimeConformanceCaseResultRecord[]>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: "user" | "service" | "workload" | "system";
    actorId: string;
    runId: string;
    requestId: string;
    after: unknown;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    /** 事件类型固定为 runtime.conformance.recorded。 */
    eventType: "runtime.conformance.recorded";
    aggregateId: string;
    /** 聚合版本号。 */
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<void>;
  completeIdempotency(params: {
    recordId: string;
    httpStatus: number;
    responseRef: string | null;
    responseRedactedJson: string;
    completedAt: Date;
  }): Promise<boolean>;
}
