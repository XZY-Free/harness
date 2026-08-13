/**
 * DSSE Envelope 类型与解析。
 *
 * 事实源：https://github.com/secure-systems-lab/dsse/blob/v1.0.0/protocol.md
 *
 * Envelope 结构：
 * {
 * payloadType: string,
 * payload: string, // base64 编码
 * signatures: [{ keyid: string, sig: string }] // sig base64 编码
 * }
 *
 * 本模块仅负责解析与 digest 计算；验签在 verifier.ts 中。
 */
import { createHash } from "node:crypto";

/** DSSE Envelope（RFC 规范结构）。 */
export interface DSSEEnvelope {
  payloadType: string;
  payload: string; // base64 编码
  signatures: DSSESignature[];
}

/** DSSE 签名条目。 */
export interface DSSESignature {
  keyid: string;
  sig: string; // base64 编码
}

/** 解析结果：成功时返回 envelope 与解码后的 payload 字节。 */
export type ParseDSSEEnvelopeResult =
  | { ok: true; envelope: DSSEEnvelope; payloadBytes: Buffer }
  | { ok: false; reason: string };

/**
 * 解析 Envelope JSON，返回结构化结果。
 *
 * 校验：
 * 1. JSON 合法且为对象
 * 2. payloadType 存在且为字符串
 * 3. payload 存在且为字符串
 * 4. signatures 是非空数组，每个元素含 keyid/sig 字符串
 * 5. payload 可 base64 解码
 *
 * 失败时返回 { ok: false, reason }，不抛错。
 */
export function parseDSSEEnvelope(envelopeBytes: Buffer | string): ParseDSSEEnvelopeResult {
  // 1. JSON 解析
  let parsed: unknown;
  try {
    const text =
      typeof envelopeBytes === "string" ? envelopeBytes : envelopeBytes.toString("utf-8");
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "dsse_envelope_json_parse_failed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "dsse_envelope_json_parse_failed" };
  }
  const env = parsed as Record<string, unknown>;

  // 2. payloadType
  if (typeof env.payloadType !== "string") {
    return { ok: false, reason: "dsse_payload_type_missing" };
  }
  const payloadType = env.payloadType;

  // 3. payload
  if (typeof env.payload !== "string") {
    return { ok: false, reason: "dsse_payload_missing" };
  }
  const payloadStr = env.payload;

  // 4. signatures 数组
  if (!Array.isArray(env.signatures) || env.signatures.length === 0) {
    return { ok: false, reason: "dsse_signatures_missing" };
  }
  const signatures: DSSESignature[] = [];
  for (const item of env.signatures) {
    if (!item || typeof item !== "object") {
      return { ok: false, reason: "dsse_signatures_missing" };
    }
    const sig = item as Record<string, unknown>;
    const keyid = typeof sig.keyid === "string" ? sig.keyid : "";
    const sigStr = typeof sig.sig === "string" ? sig.sig : "";
    if (!keyid || !sigStr) {
      // 跳过无效条目；调用方在 verifier.ts 中处理 unknown_keyid
      continue;
    }
    signatures.push({ keyid, sig: sigStr });
  }
  if (signatures.length === 0) {
    return { ok: false, reason: "dsse_signatures_missing" };
  }

  // 5. base64 解码 payload
  let payloadBytes: Buffer;
  try {
    payloadBytes = Buffer.from(payloadStr, "base64");
  } catch {
    return { ok: false, reason: "dsse_payload_base64_decode_failed" };
  }

  return {
    ok: true,
    envelope: { payloadType, payload: payloadStr, signatures },
    payloadBytes,
  };
}

/**
 * 计算 Envelope 字节的 sha256 digest（sha256:hex 格式）。
 *
 * 输入应是原始 Envelope JSON 字节（未做任何规范化）。
 */
export function computeEnvelopeDigest(envelopeBytes: Buffer): string {
  const hex = createHash("sha256").update(envelopeBytes).digest("hex");
  return `sha256:${hex}`;
}

/**
 * 计算 Payload 字节的 sha256 digest（sha256:hex 格式）。
 *
 * 输入应是 Envelope.payload base64 解码后的原始字节。
 */
export function computePayloadDigest(payloadBytes: Buffer): string {
  const hex = createHash("sha256").update(payloadBytes).digest("hex");
  return `sha256:${hex}`;
}
