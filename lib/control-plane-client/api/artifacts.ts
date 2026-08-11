/**
 * Artifact Attestation API Client — 消费 Attestation 端点。
 */

import type {
  ArtifactAttestationDTO,
  ArtifactAttestationListResponse,
  VerifyAttestationRequest,
  VerifyAttestationResultDTO,
} from "../contracts/artifact";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Artifact API Client。 */
export interface ArtifactApiClient {
  /** 列出 Attestation。 */
  list(): Promise<ArtifactAttestationListResponse>;
  /** 获取 Attestation 详情。 */
  get(attestationId: string): Promise<ArtifactAttestationDTO>;
  /** 验证 Attestation — DSSE + in-toto 完整信任链。 */
  verify(body: VerifyAttestationRequest): Promise<VerifyAttestationResultDTO>;
  /** 撤销 Attestation。 */
  revoke(attestationId: string, reason: string): Promise<ArtifactAttestationDTO>;
}

/** 创建 Artifact API Client。 */
export function createArtifactApiClient(config: ApiClientConfig): ArtifactApiClient {
  const request = createControlPlaneRequest(config);

  return {
    list: () => request<ArtifactAttestationListResponse>("/admin/api/v1/artifact-attestations"),
    get: (attestationId) =>
      request<ArtifactAttestationDTO>(`/admin/api/v1/artifact-attestations/${attestationId}`),
    verify: (body) =>
      request<VerifyAttestationResultDTO>("/admin/api/v1/artifact-attestations:verify", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    revoke: (attestationId, reason) =>
      request<ArtifactAttestationDTO>(
        `/admin/api/v1/artifact-attestations/${attestationId}:revoke`,
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        },
      ),
  };
}
