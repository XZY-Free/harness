/**
 * in-toto Statement v1 共享校验 — Artifact Attestation 与 Runtime Conformance 共用。
 *
 * 事实源：https://in-toto.io/Statement/v1
 *
 * 提供：
 * - Statement v1 类型 URI 常量
 * - DSSE payloadType 常量
 * - Statement 解析与 _type 校验
 * - Subject 数组与 digest 绑定校验
 *
 * Artifact 和 Conformance 各自保留 Predicate Type 语义校验，
 * 本模块不涉及 predicate 领域逻辑。
 */

/** in-toto Statement v1 类型 URI。 */
export const IN_TOTO_STATEMENT_TYPE_V1 = "https://in-toto.io/Statement/v1";

/** DSSE 标准 payloadType（in-toto + JSON）。 */
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * 解析 in-toto Statement JSON 并校验 _type。
 *
 * 返回解析后的 Statement 对象，或失败原因字符串。
 */
export function parseIntotoStatement(
 payloadBytes: Buffer,
): { ok: true; statement: Record<string, unknown> } | { ok: false; reason: string } {
 let statement: Record<string, unknown>;
 try {
 statement = JSON.parse(payloadBytes.toString("utf-8")) as Record<string, unknown>;
 } catch {
 return { ok: false, reason: "in_toto_statement_parse_failed" };
 }

 if (statement._type !== IN_TOTO_STATEMENT_TYPE_V1) {
 return { ok: false, reason: "in_toto_statement_type_invalid" };
 }

 return { ok: true, statement };
}

/**
 * 校验 Statement subject 数组存在、非空，并提取第一个 subject 的 sha256 digest。
 *
 * 返回 subject[0].digest.sha256（raw hex，无 sha256: 前缀），或失败原因。
 */
export function validateStatementSubject(
 statement: Record<string, unknown>,
): { ok: true; subjectDigestHex: string } | { ok: false; reason: string } {
 const subjects = statement.subject;
 if (!Array.isArray(subjects) || subjects.length === 0) {
 return { ok: false, reason: "in_toto_subject_missing" };
 }

 const subject0 = subjects[0] as Record<string, unknown> | undefined;
 const subjectDigest = (subject0?.digest as Record<string, unknown> | undefined)?.sha256;
 if (typeof subjectDigest !== "string") {
 return { ok: false, reason: "in_toto_subject_digest_missing" };
 }

 return { ok: true, subjectDigestHex: subjectDigest };
}

/**
 * 校验 DSSE Envelope 的 payloadType 是否为 in-toto JSON。
 */
export function validatePayloadType(payloadType: string): { ok: true } | { ok: false; reason: string } {
 if (payloadType !== DSSE_PAYLOAD_TYPE) {
 return { ok: false, reason: `dsse_payload_type_mismatch: ${payloadType}` };
 }
 return { ok: true };
}
