/**
 * control-plane-client — Web 端和桌面端共用的控制面客户端。
 *
 * 所有控制面对象的稳定 DTO、API Client 和错误模型。
 *
 * 禁止：
 * - Web 端和桌面端分别维护一套 DTO；
 * - 页面直接引用数据库 Record；
 * - 通过 revisionState 推断 Publication；
 * - 通过 currentRevisionId 推断执行资格。
 */

// ─── Contracts ─────────────────────────────────────────────

export type {
  AgentLifecycleState,
  AgentDTO,
  AgentListResponse,
  AgentContractCapabilityDTO,
  AgentContractContextDTO,
  AgentContractSnapshotDTO,
  AgentContractListResponse,
  AgentRevisionState,
  AgentRevisionDTO,
  AgentRevisionSummaryDTO,
  AgentRevisionListResponse,
  CreateAgentRevisionRequest,
  RegisterAgentContractRequest,
  RegisterAgentContractResponse,
  RegisterAgentRuntimeConformance,
  RegisterAgentRuntimeRequest,
  RegisterAgentRuntimeResponse,
  RuntimeMeasuredEvidenceDTO,
  CredentialRefSummaryDTO,
  CredentialRefListResponse,
  PublishAgentRevisionRequest,
  PublishAgentRevisionResponse,
  WithdrawAgentRevisionRequest,
  WithdrawAgentRevisionResponse,
} from "./contracts/agent";

export type {
  RuntimeKind,
  RuntimeLifecycleState,
  RuntimeDTO,
  RuntimeListResponse,
  RuntimeRevisionState,
  RuntimeRevisionDTO,
  RuntimeConformanceOverallResult,
  RuntimeConformanceCaseResultDTO,
  RuntimeConformanceRunDTO,
  RuntimeConformanceSubmissionDTO,
  PublishRuntimeRevisionRequest,
  PublishRuntimeRevisionResponse,
  RecordConformanceRunRequest,
  WithdrawRuntimeRevisionRequest,
  WithdrawRuntimeRevisionResponse,
} from "./contracts/runtime";

export type {
  AttestationFormat,
  ArtifactKind,
  AttestationState,
  ArtifactAttestationDTO,
  ArtifactAttestationListParams,
  ArtifactAttestationListResponse,
  VerifyAttestationRequest,
  VerifyAttestationResultDTO,
} from "./contracts/artifact";

export type {
  PublicationSubjectType,
  PublicationActorType,
  PublicationRecordDTO,
  WithdrawalRecordDTO,
  PublicationListResponse,
  WithdrawalListResponse,
} from "./contracts/publication";

export type {
  RouteState,
  RouteActivationState,
  RouteEligibilityState,
  DeploymentRouteSetDTO,
  DeploymentRouteDTO,
  RouteRevisionDTO,
  RouteActivationDTO,
  ActivateRouteSetRequest,
  ActivateRouteSetResponse,
  DisableRouteRequest,
  DisableRouteResponse,
} from "./contracts/route";

export type {
  HostedProvisioningState,
  ProvisioningStep,
  HostedProvisioningRequestDTO,
  RequestHostedProvisioningRequest,
} from "./contracts/provisioning";

export type { ExecutionBindingDTO } from "./contracts/execution";

// ─── Errors ────────────────────────────────────────────────

export type {
  ControlPlaneErrorCode,
  ControlPlaneError,
} from "./errors/control-plane-error";

export {
  isRetryable,
  isPermanent,
  parseControlPlaneError,
} from "./errors/control-plane-error";

// ─── API Clients ───────────────────────────────────────────

export type { ApiClientConfig } from "./http-client";
export { ControlPlaneRequestError } from "./http-client";
export type { ControlPlaneClient } from "./client";
export { createControlPlaneClient } from "./client";
export type { AgentApiClient } from "./api/agents";
export { createAgentApiClient } from "./api/agents";

export type { CredentialRefApiClient } from "./api/credentials";
export { createCredentialRefApiClient } from "./api/credentials";

export type { RuntimeApiClient } from "./api/runtimes";
export { createRuntimeApiClient } from "./api/runtimes";

export type { ArtifactApiClient } from "./api/artifacts";
export { createArtifactApiClient } from "./api/artifacts";

export type { PublicationApiClient } from "./api/publications";
export { createPublicationApiClient } from "./api/publications";

export type { RouteApiClient } from "./api/routes";
export { createRouteApiClient } from "./api/routes";

export type { ProvisioningApiClient } from "./api/provisioning";
export { createProvisioningApiClient } from "./api/provisioning";

export type { ExecutionApiClient } from "./api/executions";
export { createExecutionApiClient } from "./api/executions";
