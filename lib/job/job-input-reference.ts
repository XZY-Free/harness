import { rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
import { getFileStorageProvider } from "@/lib/files/storage-bootstrap";
import { computeJobInputDigest } from "@/lib/job/job-input-digest";

const HASH = /^sha256:[0-9a-f]{64}$/;

/** 领域创建方经当前部署的文件 Provider 保存 JSON 输入，再将返回值冻结到 Job。 */
export async function storeJobInputReference(input: {
  tenantId: string;
  payload: unknown;
}): Promise<{ inputRef: string; inputHash: string }> {
  const payload = input.payload ?? null;
  const inputHash = computeJobInputDigest(payload);
  const provider = await getFileStorageProvider();
  if (!provider.jobInput) throw new Error("InputUnavailable");
  const stored = await provider.jobInput.store({
    tenantId: input.tenantId,
    digest: inputHash,
    content: Buffer.from(rfc8785Canonicalize(payload), "utf8"),
  });
  await resolveJobInputReference({
    tenantId: input.tenantId,
    inputRef: stored.resourceRef,
    inputHash,
  });
  return { inputRef: stored.resourceRef, inputHash };
}

/** 每次实际读取时独立取回内容；从不以 Job 行上的 hash 自证内容未变。 */
export async function resolveJobInputReference(input: {
  tenantId: string;
  inputRef: string;
  inputHash: string;
}): Promise<unknown> {
  if (!HASH.test(input.inputHash)) throw new Error("InputDigestMismatch");
  const provider = await getFileStorageProvider();
  if (!provider.jobInput) throw new Error("InputUnavailable");
  const bytes = await provider.jobInput.read({
    tenantId: input.tenantId,
    resourceRef: input.inputRef,
  });
  if (!bytes) throw new Error("InputUnavailable");
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("InputDigestMismatch");
  }
  if (computeJobInputDigest(payload) !== input.inputHash) throw new Error("InputDigestMismatch");
  return payload;
}
