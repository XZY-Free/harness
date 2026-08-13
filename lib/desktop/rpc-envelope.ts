/**
 * ：RPC 信封 schema 和规范序列化。
 *
 * Server 和 Desktop 之间的 RPC 通信使用严格类型的信封结构。所有信封必须通过
 * zod schema 校验，确保字段完整、类型正确。签名覆盖信封的规范序列化，
 * 防止字段重排或额外字段绕过验签。
 *
 * 安全约束：
 * - 信封字段不可缺省，必填字段必须存在且类型正确
 * - 签名 payload 排除 signature 字段本身（自签名无意义）
 * - 规范序列化保证字段按字母序排列，跨平台一致
 */
import { z } from "zod";

/**
 * RPC 请求信封 schema（Server → Desktop）。
 */
export const rpcRequestEnvelopeSchema = z.object({
  protocolVersion: z.number().int().positive(),
  requestId: z.string().min(1),
  deviceId: z.string().min(1),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  tabId: z.string().nullable(),
  runId: z.string().nullable(),
  approvalId: z.string().nullable(),
  command: z.string().min(1),
  payload: z.unknown(),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

export type RpcRequestEnvelope = z.infer<typeof rpcRequestEnvelopeSchema>;

/**
 * RPC 结果信封 schema（Desktop → Server）。
 */
export const rpcResultEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  deviceId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      detail: z.unknown().nullable(),
    })
    .nullable(),
  timestamp: z.number().int().positive(),
  signature: z.string().min(1),
});

export type RpcResultEnvelope = z.infer<typeof rpcResultEnvelopeSchema>;

/**
 * 规范序列化：将对象按字段名字母序递归排序后 JSON.stringify。
 *
 * 嵌套对象也递归排序，数组保持元素顺序（数组元素如果是对象则递归排序）。
 * 用于生成签名的 payload，确保跨平台一致的序列化结果。
 *
 * @param data 待序列化的对象
 * @returns 规范 JSON 字符串
 */
export function canonicalSerialize(data: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(data));
}

/**
 * 递归将对象字段按字母序排列，返回可直接 JSON.stringify 的结构。
 */
function canonicalize(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    // 数组保持顺序，但元素递归处理
    return value.map((v) => canonicalize(v));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const sorted: Record<string, unknown> = {};
    for (const key of keys) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  // 基本类型直接返回
  return value;
}

/**
 * 获取请求信封的待签名字符串（排除 signature 字段）。
 *
 * @param envelope 不含 signature 字段的请求信封
 * @returns 规范序列化后的字符串
 */
export function getEnvelopeSignPayload(envelope: Omit<RpcRequestEnvelope, "signature">): string {
  const { signature: _, ...rest } = envelope as RpcRequestEnvelope;
  void _;
  return canonicalSerialize(rest);
}

/**
 * 获取结果信封的待签名字符串（排除 signature 字段）。
 *
 * @param envelope 不含 signature 字段的结果信封
 * @returns 规范序列化后的字符串
 */
export function getResultSignPayload(envelope: Omit<RpcResultEnvelope, "signature">): string {
  const { signature: _, ...rest } = envelope as RpcResultEnvelope;
  void _;
  return canonicalSerialize(rest);
}
