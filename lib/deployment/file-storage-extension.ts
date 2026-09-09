import type { FileStorageExtension } from "@/lib/files/storage-extension";
import { workspaceFileStorageProvider } from "@/lib/files/workspace-storage-provider";

/** 开源发行版默认把原文件保存到所属 Thread Workspace。私有发行版可替换本组合根。 */
export function createFileStorageExtension(): FileStorageExtension {
  return { provider: workspaceFileStorageProvider };
}
