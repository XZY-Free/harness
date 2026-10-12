import { apiFetch } from "@/lib/api-fetch";

export type ThreadAttachmentFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface UploadedThreadAttachment {
  readonly attachmentId: string;
  readonly filename: string;
}

interface UploadResponseBody {
  readonly attachment_id?: unknown;
  readonly filename?: unknown;
  readonly error?: unknown;
}

async function uploadError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as UploadResponseBody | null;
  const message =
    typeof body?.error === "string" && body.error.trim()
      ? body.error
      : "文件上传失败，请稍后重试。";
  return new Error(message);
}

export async function uploadThreadAttachment(
  threadId: string,
  file: File,
  idempotencyKey: string,
  fetchImpl: ThreadAttachmentFetch = apiFetch,
): Promise<UploadedThreadAttachment> {
  const formData = new FormData();
  formData.set("file", file);
  const response = await fetchImpl(`/api/threads/${threadId}/attachments`, {
    method: "POST",
    credentials: "include",
    headers: { "idempotency-key": idempotencyKey },
    body: formData,
  });
  if (!response.ok) throw await uploadError(response);
  const body = (await response.json()) as UploadResponseBody;
  if (typeof body.attachment_id !== "string" || !body.attachment_id) {
    throw new Error("文件已上传，但服务器未返回附件标识，请重试。");
  }
  return {
    attachmentId: body.attachment_id,
    filename: typeof body.filename === "string" ? body.filename : file.name,
  };
}
