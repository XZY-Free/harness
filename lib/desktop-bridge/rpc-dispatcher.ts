import { isAllowedCommand, validateCommandPayload } from "../desktop/commands";
/**
 * V10 Phase 5：RPC 分发器。
 *
 * 创建签名的 RPC 请求信封，准备发送到目标 Desktop 设备。
 * 信封包含完整字段：协议版本、目标设备、用户、命令、payload、签名等。
 *
 * 安全约束：
 * - 命令必须在白名单内（unknown_command 拒绝）
 * - payload 必须通过 schema 校验（rpc_invalid_payload 拒绝）
 * - 信封签名覆盖所有字段（除 signature 本身）
 * - expiresAt 必须明确设置，防止过期请求被执行
 */
import { PROTOCOL_VERSION } from "../desktop/protocol";
import { type RpcRequestEnvelope, getEnvelopeSignPayload } from "../desktop/rpc-envelope";
import { generateNonce, generateRequestId, signData } from "../desktop/signing";

/**
 * 默认信封 TTL：30 秒。
 */
const DEFAULT_DISPATCH_TTL_MS = 30000;

/**
 * 分发参数。
 */
export interface DispatchParams {
  /** 目标设备 ID */
  deviceId: string;
  /** 用户 ID */
  userId: string;
  /** thread ID */
  threadId: string;
  /** 命令字符串 */
  command: string;
  /** 命令 payload */
  payload: unknown;
  /** Server 私钥（base64） */
  serverPrivateKeyBase64: string;
  /** TTL（毫秒），默认 30000 */
  ttlMs?: number;
  /** 关联的 tab ID（可选） */
  tabId?: string | null;
  /** 关联的 run ID（可选） */
  runId?: string | null;
  /** 关联的 approval ID（可选） */
  approvalId?: string | null;
}

/**
 * 分发结果。
 *
 * 鉴别联合：ok=true 时持有 envelope，ok=false 时持有 code/message。
 */
export type DispatchResult =
  | { ok: true; envelope: RpcRequestEnvelope }
  | { ok: false; code: string; message?: string };

/**
 * 创建签名的 RPC 请求信封。
 *
 * @param params 分发参数
 * @param now 当前时间（epoch ms）
 * @returns 签名后的 RPC 请求信封
 */
export function createSignedEnvelope(params: DispatchParams, now: number): RpcRequestEnvelope {
  const ttlMs = params.ttlMs ?? DEFAULT_DISPATCH_TTL_MS;
  // 构建不含 signature 的信封
  const unsigned: Omit<RpcRequestEnvelope, "signature"> = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    deviceId: params.deviceId,
    userId: params.userId,
    threadId: params.threadId,
    tabId: params.tabId ?? null,
    runId: params.runId ?? null,
    approvalId: params.approvalId ?? null,
    command: params.command,
    payload: params.payload,
    issuedAt: now,
    expiresAt: now + ttlMs,
    nonce: generateNonce(),
  };
  // 计算签名
  const signPayload = getEnvelopeSignPayload(unsigned);
  const signature = signData(signPayload, params.serverPrivateKeyBase64);
  return {
    ...unsigned,
    signature,
  };
}

/**
 * 准备 RPC 分发（创建信封，不发送）。
 *
 * 流程：
 * 1. 校验命令在白名单内
 * 2. 校验 payload schema
 * 3. 创建签名信封
 *
 * @param params 分发参数
 * @param now 当前时间（epoch ms）
 * @returns 成功返回信封，失败返回错误码
 */
export function prepareDispatch(params: DispatchParams, now: number): DispatchResult {
  // 1. 命令白名单检查
  if (!isAllowedCommand(params.command)) {
    return {
      ok: false,
      code: "unknown_command",
      message: `未知命令：${params.command}`,
    };
  }
  // 2. payload schema 校验
  const payloadResult = validateCommandPayload(params.command, params.payload);
  if (!payloadResult.ok) {
    return {
      ok: false,
      code: "rpc_invalid_payload",
      message: `payload 校验失败：${payloadResult.error}`,
    };
  }
  // 3. 创建签名信封（payload 使用校验后的数据）
  const envelope = createSignedEnvelope(
    {
      ...params,
      payload: payloadResult.payload,
    },
    now,
  );
  return { ok: true, envelope };
}
