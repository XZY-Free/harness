import { createFileStorageExtension } from "@/lib/deployment/file-storage-extension";
import { FileStorageBootstrap } from "@/lib/files/storage-extension";

const runtimeBootstrap = new FileStorageBootstrap(async () => createFileStorageExtension());

export async function getFileStorageProvider() {
  return (await runtimeBootstrap.initialize()).provider;
}

export function assertFileStorageReady() {
  return runtimeBootstrap.initialize();
}
