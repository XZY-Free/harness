import type { db } from "@/lib/db/client";
import {
 AUDIENCE_PREFIX,
 IDEMPOTENCY_KEY_HEADER,
 IF_MATCH_HEADER,
 REQUEST_ID_HEADER,
 generateRequestId,
} from "@/lib/http";
import type { ApiAudience } from "@/lib/http";
/**
 * V11 四类 API 测试夹具（）。
 *
 * 为 employee/runtime/gateway/admin 四类 audience 建立统一测试夹具：
 * - `buildV11Request`：统一请求身份（X-Request-ID、Idempotency-Key、If-Match、Authorization）。
 * - `withRollback`：事务回滚夹具，保证有副作用的测试不污染共享 DB。
 * - `assertIdempotencyConflict` / `assertCrossTenantHidden`：幂等重放与跨租户拒绝的断言夹具；
 * 阶段 2 引入 idempotency_record 与 tenant 表后，路由实际执行这些语义，本夹具直接复用。
 *
 * 这些夹具连接真实 MySQL 8（lib/db/test/global-setup.ts 起的 container），不使用 mock。
 */
import { expect } from "vitest";

/** 项目实际 Drizzle DB 类型（MySql2Database<typeof schema>）。 */
type DbClient = typeof db;
/** db.transaction 回调的 tx 参数类型（MySqlTransaction，无 $client）。 */
type TxClient = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// ApiAudience / AUDIENCE_PREFIX 已迁移至 lib/http.ts（S02-C01：身份解析器需引用）。
export type { ApiAudience } from "@/lib/http";
export { AUDIENCE_PREFIX } from "@/lib/http";

export interface BuildV11RequestOptions {
 audience: ApiAudience;
 method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
 /** 路径，不含 audience 前缀，如 `/threads` 或 `/threads/{id}` 字面值。 */
 path: string;
 /** Bearer token；测试夹具用占位 token，真实身份由阶段 2 接入。 */
 token?: string;
 /** 显式 X-Request-ID；不传则平台生成。 */
 requestId?: string;
 /** 创建/命令 POST 的幂等键；POST 时建议必填。 */
 idempotencyKey?: string;
 /** 可编辑资源 PUT/PATCH 的 ETag 值（裸值，夹具自动加引号）。 */
 ifMatch?: string;
 /** 请求体；对象自动 JSON.stringify。 */
 body?: unknown;
 /** 额外头。 */
 headers?: Record<string, string>;
}

/**
 * 构造一个带 V11 公共协议头的 Request，供路由 handler 单元/集成测试使用。
 * 不发起网络请求，仅构造对象，路由以 `handler(req)` 方式调用。
 */
export function buildV11Request(options: BuildV11RequestOptions): Request {
 const requestId = options.requestId ?? generateRequestId();
 const url = `https://snow.test${AUDIENCE_PREFIX[options.audience]}${options.path}`;
 const headers: Record<string, string> = {
 [REQUEST_ID_HEADER]: requestId,
 "content-type": "application/json",
 ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
 ...(options.idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey } : {}),
 ...(options.ifMatch ? { [IF_MATCH_HEADER]: `"${options.ifMatch}"` } : {}),
 ...(options.headers ?? {}),
 };
 const init: RequestInit = { method: options.method, headers };
 if (options.body !== undefined && options.method !== "GET" && options.method !== "DELETE") {
 init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
 }
 return new Request(url, init);
}

/**
 * 事务回滚夹具：在事务中执行 fn，无论成功失败都回滚，不污染共享 DB。
 * 用 sentinel 强制回滚；fn 抛出的真实错误原样向上抛。
 */
export async function withRollback<T>(db: DbClient, fn: (tx: TxClient) => Promise<T>): Promise<T> {
 const sentinel = Symbol("rollback");
 let result: T | undefined;
 let hasResult = false;
 try {
 await db.transaction(async (tx) => {
 result = await fn(tx);
 hasResult = true;
 throw sentinel;
 });
 } catch (err) {
 if (err === sentinel) {
 if (!hasResult) {
 throw new Error("withRollback: fn completed without result");
 }
 return result as T;
 }
 throw err;
 }
 // 不应到达：transaction 总是因 sentinel 回滚。
 throw new Error("withRollback: transaction unexpectedly committed");
}

/**
 * 幂等重放断言夹具：同 Idempotency-Key 重放应返回 409 IDEMPOTENCY_CONFLICT。
 * 阶段 2 引入 idempotency_record 后，路由实际执行该语义。
 */
export async function assertIdempotencyConflict(
 response: Response,
 requestId: string,
): Promise<void> {
 expect(response.status, "idempotency replay should be 409").toBe(409);
 const body = (await response.json()) as { error: { code: string; request_id: string } };
 expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
 expect(body.error.request_id).toBe(requestId);
}

/**
 * 跨租户拒绝断言夹具：访问他租户资源应返回 404 RESOURCE_NOT_FOUND（隐藏式，非 403）。
 * 阶段 2 引入 tenant 隔离后，路由实际执行该语义。
 */
export async function assertCrossTenantHidden(
 response: Response,
 requestId: string,
): Promise<void> {
 expect(response.status, "cross-tenant access should be hidden as 404").toBe(404);
 const body = (await response.json()) as { error: { code: string; request_id: string } };
 expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
 expect(body.error.request_id).toBe(requestId);
}
