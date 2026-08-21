/**
 * Artifact Attestation API Client — 消费 Attestation 端点。
 */

import type {
  ArtifactAttestationDTO,
  ArtifactAttestationListParams,
  ArtifactAttestationListResponse,
  VerifyAttestationRequest,
  VerifyAttestationResultDTO,
} from "../contracts/artifact";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Artifact API Client。 */
export interface ArtifactApiClient {
  /** 列出 Attestation。 */
  list(params?: ArtifactAttestationListParams): Promise<ArtifactAttestationListResponse>;
  /** 获取 Attestation 详情。 */
  get(attestationId: string): Promise<ArtifactAttestationDTO>;
  /** 验证 Attestation — DSSE + in-toto 完整信任链。 */
  verify(
    body: VerifyAttestationRequest,
    opts: { idempotencyKey: string },
  ): Promise<VerifyAttestationResultDTO>;
  /** 撤销 Attestation。 */
  revoke(attestationId: string, reason: string): Promise<ArtifactAttestationDTO>;
}

/** 创建 Artifact API Client。 */
export function createArtifactApiClient(config: ApiClientConfig): ArtifactApiClient {
  const request = createControlPlaneRequest(config);

  return {
    list: (params = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) query.set(key, String(value));
      }
      const suffix = query.size > 0 ? `?${query}` : "";
      return request<ArtifactAttestationListResponse>(
        `/admin/api/v1/artifact-attestations${suffix}`,
      );
    },
    get: (attestationId) =>
      request<ArtifactAttestationDTO>(`/admin/api/v1/artifact-attestations/${attestationId}`),
    verify: (body, opts) =>
      request<VerifyAttestationResultDTO>("/admin/api/v1/artifact-attestations/verify", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": opts.idempotencyKey },
      }),
    revoke: (attestationId, reason) =>
      request<ArtifactAttestationDTO>(
        `/admin/api/v1/artifact-attestations/${attestationId}/revoke`,
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        },
      ),
  };
}
