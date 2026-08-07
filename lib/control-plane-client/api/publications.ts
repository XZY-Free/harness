/**
 * Publication / Withdrawal API Client — 消费 Publication 端点。
 */

import type {
  PublicationRecordDTO,
  PublicationListResponse,
  WithdrawalRecordDTO,
  WithdrawalListResponse,
} from "../contracts/publication";
import type { ApiClientConfig } from "./agents";

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
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${config.baseUrl}${path}`;
    const headers = { ...config.headers(), "Content-Type": "application/json" };
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), {
        code: body.code,
        request_id: body.request_id,
        details: body.details,
      });
    }
    return res.json();
  }

  return {
    list: (subjectType, subjectId) =>
      request<PublicationListResponse>(`/admin/api/v1/publications?subject_type=${subjectType}&subject_id=${subjectId}`),
    get: (recordId) =>
      request<PublicationRecordDTO>(`/admin/api/v1/publications/${recordId}`),
    listWithdrawals: (subjectType, subjectId) =>
      request<WithdrawalListResponse>(`/admin/api/v1/withdrawals?subject_type=${subjectType}&subject_id=${subjectId}`),
    getWithdrawal: (recordId) =>
      request<WithdrawalRecordDTO>(`/admin/api/v1/withdrawals/${recordId}`),
  };
}
