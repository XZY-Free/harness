/** SnowHarness 原文件存储端口。一个部署只装配一个提供器，不做隐式双写。 */
export interface FileStorageProvider {
  readonly name: string;
  store(input: StoreFileObjectInput): Promise<StoredFileObject>;
  read(input: ReadFileObjectInput): Promise<Buffer | null>;
  delete(input: DeleteFileObjectInput): Promise<boolean>;
}

export type FileResourceKind = "attachment" | "artifact";

export interface StoreFileObjectInput {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly resourceId: string;
  readonly resourceKind: FileResourceKind;
  readonly originalFilename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface StoredFileObject {
  /** 仅由同一个 Provider 解释的受管引用，不是客户端可访问 URL。 */
  readonly resourceRef: string;
}

export interface ReadFileObjectInput {
  readonly tenantId: string;
  readonly threadId: string;
  readonly resourceRef: string;
}

export interface DeleteFileObjectInput extends ReadFileObjectInput {}
