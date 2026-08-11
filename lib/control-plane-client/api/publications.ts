/**
 * Publication / Withdrawal API Client — 消费 Publication 端点。
 */

import type {
  PublicationListResponse,
  PublicationRecordDTO,
  WithdrawalListResponse,
  WithdrawalRecordDTO,
} from "../contracts/publication";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Publication API Client。 */
export interface PublicationApiClient {
  /** 列出 Publication Record。 */
  list(subjectType: string, subjectId: string): Promise<PublicationListResponse>;
  /** 获取 Publication Record 详情。 */
  get(recordId: string): Promise<PublicationRecordDTO>;
  /** 列出 Withdrawal Record。 */
  listWithdrawals(subjectType: string, subjectId: string): Promise<WithdrawalListResponse>;
  /** 获取 Withdrawal Record 详情。 */
  getWithdrawal(recordId: string): Promise<WithdrawalRecordDTO>;
}

/** 创建 Publication API Client。 */
export function createPublicationApiClient(config: ApiClientConfig): PublicationApiClient {
  const request = createControlPlaneRequest(config);

  return {
    list: (subjectType, subjectId) =>
      request<PublicationListResponse>(
        `/admin/api/v1/publications?subject_type=${subjectType}&subject_id=${subjectId}`,
      ),
    get: (recordId) => request<PublicationRecordDTO>(`/admin/api/v1/publications/${recordId}`),
    listWithdrawals: (subjectType, subjectId) =>
      request<WithdrawalListResponse>(
        `/admin/api/v1/withdrawals?subject_type=${subjectType}&subject_id=${subjectId}`,
      ),
    getWithdrawal: (recordId) =>
      request<WithdrawalRecordDTO>(`/admin/api/v1/withdrawals/${recordId}`),
  };
}
