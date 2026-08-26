/**
 * CredentialRef API Client — 消费 /admin/api/v1/credential-refs（07 §7）。
 *
 * bearer 模式的 External Runtime 登记只能选择已有 CredentialRef；
 * 禁止 Secret 文本框 / raw secret 传输。
 */

import type { CredentialRefListResponse } from "../contracts/agent";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** CredentialRef API Client。 */
export interface CredentialRefApiClient {
  /** 列出租户 CredentialRef 摘要（无 vaultRef/secret）。 */
  list(): Promise<CredentialRefListResponse>;
}

/** 创建 CredentialRef API Client。 */
export function createCredentialRefApiClient(config: ApiClientConfig): CredentialRefApiClient {
  const request = createControlPlaneRequest(config);
  return {
    list: () => request<CredentialRefListResponse>("/admin/api/v1/credential-refs"),
  };
}
