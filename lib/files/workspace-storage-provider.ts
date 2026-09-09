import type {
  DeleteFileObjectInput,
  FileStorageProvider,
  ReadFileObjectInput,
  StoreFileObjectInput,
  StoredFileObject,
} from "@/lib/files/storage-provider";
import {
  deleteWorkspaceFile,
  readWorkspaceFileBytes,
  writeWorkspaceFileBytes,
} from "@/lib/workspace";

const MANAGED_FILE_PREFIX = ".snow/files/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 默认单机实现：原文件保存在所属 Thread Workspace，文件名不参与物理路径。 */
export const workspaceFileStorageProvider: FileStorageProvider = {
  name: "workspace",

  async store(input: StoreFileObjectInput): Promise<StoredFileObject> {
    if (input.resourceKind !== "attachment" && input.resourceKind !== "artifact") {
      throw new Error("Workspace 文件资源类型非法");
    }
    if (!UUID_PATTERN.test(input.resourceId)) {
      throw new Error("Workspace 文件资源 id 非法");
    }
    const resourceRef = `${MANAGED_FILE_PREFIX}${input.resourceKind}/${input.resourceId}/content`;
    await writeWorkspaceFileBytes(input.threadId, resourceRef, input.content);
    return { resourceRef };
  },

  async read(input: ReadFileObjectInput): Promise<Buffer | null> {
    assertManagedResourceRef(input.resourceRef);
    const bytes = await readWorkspaceFileBytes(input.threadId, input.resourceRef);
    return bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  },

  async delete(input: DeleteFileObjectInput): Promise<boolean> {
    assertManagedResourceRef(input.resourceRef);
    return deleteWorkspaceFile(input.threadId, input.resourceRef);
  },
};

function assertManagedResourceRef(resourceRef: string): void {
  const segments = resourceRef.split("/");
  if (
    segments.length !== 5 ||
    segments[0] !== ".snow" ||
    segments[1] !== "files" ||
    !["attachment", "artifact"].includes(segments[2] ?? "") ||
    !UUID_PATTERN.test(segments[3] ?? "") ||
    segments[4] !== "content"
  ) {
    throw new Error("Workspace 文件引用不是受管文件路径");
  }
}
