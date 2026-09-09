import type { FileStorageProvider } from "@/lib/files/storage-provider";

export interface FileStorageExtension {
  readonly provider: FileStorageProvider;
}

export type FileStorageExtensionFactory = () =>
  | FileStorageExtension
  | Promise<FileStorageExtension>;

export class FileStorageConfigurationError extends Error {
  constructor(
    public readonly code: "file_storage_invalid" | "file_storage_provider_conflict",
    message: string,
  ) {
    super(message);
    this.name = "FileStorageConfigurationError";
  }
}

/** 进程级组合根；首次初始化后冻结，禁止请求期间替换 Provider。 */
export class FileStorageBootstrap {
  private initialization: Promise<FileStorageExtension> | null = null;
  private selected: FileStorageExtension | null = null;

  constructor(private readonly factory: FileStorageExtensionFactory) {}

  initialize(): Promise<FileStorageExtension> {
    if (this.initialization) return this.initialization;
    this.initialization = Promise.resolve()
      .then(() => this.factory())
      .then((extension) => {
        validateExtension(extension);
        this.selected = extension;
        return extension;
      });
    return this.initialization;
  }

  assertSameProvider(extension: FileStorageExtension): void {
    if (!this.selected) {
      throw new FileStorageConfigurationError("file_storage_invalid", "文件存储扩展尚未完成初始化");
    }
    if (this.selected.provider !== extension.provider) {
      throw new FileStorageConfigurationError(
        "file_storage_provider_conflict",
        "文件存储扩展已冻结，不能替换 Provider",
      );
    }
  }
}

function validateExtension(extension: FileStorageExtension): void {
  const provider = extension?.provider;
  if (
    !provider ||
    typeof provider.name !== "string" ||
    provider.name.trim().length === 0 ||
    typeof provider.store !== "function" ||
    typeof provider.read !== "function" ||
    typeof provider.delete !== "function"
  ) {
    throw new FileStorageConfigurationError(
      "file_storage_invalid",
      "文件存储扩展必须提供具名的 store/read/delete Provider",
    );
  }
}
