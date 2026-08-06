/**
 * ：ed25519 签名工具。
 *
 * Server 和 Desktop 共享的签名/验证逻辑。使用 node:crypto 内置 ed25519 算法，
 * 不引入外部加密库。Server 用私钥签名 RPC 信封，Desktop 用公钥验签。
 *
 * 安全约束：
 * - 私钥仅在 Server 端持有，Desktop 端只存储公钥
 * - 签名覆盖信封的规范序列化（canonicalSerialize），防止字段重排绕过验签
 * - nonce 和 requestId 使用 crypto.randomBytes，具备足够的熵
 */
import {
 type KeyObject,
 createPrivateKey,
 createPublicKey,
 generateKeyPairSync,
 randomBytes,
 randomUUID,
 sign,
 verify,
} from "node:crypto";

/**
 * 设备密钥对（base64 编码）。
 */
export interface DeviceKeyPair {
 /** base64 编码的公钥（raw 32 字节） */
 publicKeyBase64: string;
 /** base64 编码的私钥（PKCS8 DER） */
 privateKeyBase64: string;
}

/**
 * 生成 ed25519 密钥对。
 *
 * 公钥导出为 raw 32 字节后 base64 编码（通过 JWK 提取 x 字段）。
 * 私钥导出为 PKCS8 DER 格式后 base64 编码。
 *
 * @returns ed25519 密钥对
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
 const { publicKey, privateKey } = generateKeyPairSync("ed25519");
 // 通过 JWK 提取 raw 32 字节公钥
 const jwk = publicKey.export({ format: "jwk" });
 const rawPublicKey = Buffer.from(jwk.x as string, "base64url");
 const publicKeyBase64 = rawPublicKey.toString("base64");
 const privateKeyBase64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
 return { publicKeyBase64, privateKeyBase64 };
}

/**
 * 将数据统一转为 Buffer。
 */
function toBuffer(data: Buffer | string): Buffer {
 return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

/**
 * 校验字符串是否为合法 base64 格式。
 */
function isValidBase64(str: string): boolean {
 if (typeof str !== "string" || str.length === 0) {
 return false;
 }
 // base64 标准字符集，长度为 4 的倍数
 return /^[A-Za-z0-9+/]+={0,2}$/.test(str) && str.length % 4 === 0;
}

/**
 * 对数据签名。
 *
 * @param data 待签名数据
 * @param privateKeyBase64 base64 编码的 PKCS8 私钥
 * @returns base64 编码的签名
 * @throws 私钥格式无效时抛出错误
 */
export function signData(data: Buffer | string, privateKeyBase64: string): string {
 if (typeof privateKeyBase64 !== "string" || privateKeyBase64.length === 0) {
 throw new Error("无效的私钥：必须为非空 base64 字符串");
 }
 let privateKey: KeyObject;
 try {
 const der = Buffer.from(privateKeyBase64, "base64");
 privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
 } catch (e) {
 throw new Error(`无效的私钥：${e instanceof Error ? e.message : String(e)}`);
 }
 const sig = sign(null, toBuffer(data), privateKey);
 return sig.toString("base64");
}

/**
 * 验证签名。
 *
 * @param data 原始数据
 * @param signatureBase64 base64 编码的签名
 * @param publicKeyBase64 base64 编码的公钥（raw 32 字节）
 * @returns 验证通过返回 true，否则返回 false
 * @throws 公钥或签名格式无效时抛出错误
 */
export function verifySignature(
 data: Buffer | string,
 signatureBase64: string,
 publicKeyBase64: string,
): boolean {
 if (typeof publicKeyBase64 !== "string" || publicKeyBase64.length === 0) {
 throw new Error("无效的公钥：必须为非空 base64 字符串");
 }
 if (typeof signatureBase64 !== "string" || signatureBase64.length === 0) {
 throw new Error("无效的签名：必须为非空 base64 字符串");
 }
 if (!isValidBase64(signatureBase64)) {
 throw new Error("无效的签名：不是合法 base64 格式");
 }
 // 从 raw 32 字节公钥重建 KeyObject
 let publicKey: KeyObject;
 try {
 const rawKey = Buffer.from(publicKeyBase64, "base64");
 if (rawKey.length !== 32) {
 throw new Error(`公钥长度不正确：期望 32 字节，实际 ${rawKey.length} 字节`);
 }
 const x = rawKey.toString("base64url");
 publicKey = createPublicKey({
 key: { kty: "OKP", crv: "Ed25519", x },
 format: "jwk",
 });
 } catch (e) {
 throw new Error(`无效的公钥：${e instanceof Error ? e.message : String(e)}`);
 }
 const sig = Buffer.from(signatureBase64, "base64");
 if (sig.length === 0) {
 throw new Error("无效的签名：解码后为空");
 }
 return verify(null, toBuffer(data), publicKey, sig);
}

/**
 * 生成随机 nonce（32 字节，base64 编码）。
 *
 * 用于 RPC 信封防重放，每个请求必须携带唯一 nonce。
 *
 * @returns base64 编码的 32 字节随机数
 */
export function generateNonce(): string {
 return randomBytes(32).toString("base64");
}

/**
 * 生成随机 requestId（UUID v4 格式）。
 *
 * @returns UUID v4 字符串
 */
export function generateRequestId(): string {
 return randomUUID();
}
