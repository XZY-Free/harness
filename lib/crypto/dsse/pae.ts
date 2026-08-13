/**
 * DSSE Pre-Authentication Encoding (PAE)。
 *
 * 事实源：https://github.com/secure-systems-lab/dsse/blob/v1.0.0/protocol.md
 *
 * PAE = "DSSEv1" + SP + str(len(payloadType)) + SP + payloadType + SP + str(len(payload)) + SP + payload
 *
 * SP 为单字节空格（0x20）。所有长度均为 ASCII 十进制字符串，不带前导零。
 */

/**
 * 构造 DSSE PAE 字节。
 *
 * @param payloadType DSSE payloadType 字符串
 * @param payload 原始 payload 字节
 * @returns PAE 字节流，用于 Ed25519 验签输入
 */
export function computeDssePae(payloadType: string, payload: Buffer): Buffer {
  const prefix = Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `);
  return Buffer.concat([prefix, payload]);
}
