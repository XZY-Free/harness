import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { workspaceConfig } from "@/lib/config";
import type { JobInputStorage } from "@/lib/files/storage-provider";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const REF = /^job-input:sha256:([0-9a-f]{64})$/;

function rootForTenant(tenantId: string): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("JobInputStorageTenantInvalid");
  const configured = workspaceConfig.root;
  const base = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  return join(base, ".snow", "job-inputs", tenantId);
}

async function assertStorageDirectories(root: string, create: boolean): Promise<boolean> {
  const parts: string[] = [];
  let current = root;
  while (current !== resolve(current, "..")) {
    parts.unshift(current);
    current = resolve(current, "..");
  }
  for (const directory of parts) {
    if (create)
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("JobInputStoragePathInvalid");
  }
  return true;
}

/** 默认文件 Provider 的无 Thread、租户隔离、按内容寻址的 Job 输入目录。 */
export const workspaceJobInputStorage: JobInputStorage = {
  async store(input) {
    const match = DIGEST.exec(input.digest);
    if (!match) throw new Error("InputDigestMismatch");
    const actual = createHash("sha256").update(input.content).digest("hex");
    if (actual !== match[1]) throw new Error("InputDigestMismatch");
    const root = rootForTenant(input.tenantId);
    await assertStorageDirectories(root, true);
    const target = join(root, actual);
    const temporary = join(root, `${actual}.${randomUUID()}.tmp`);
    await writeFile(temporary, input.content, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const existing = await this.read({
        tenantId: input.tenantId,
        resourceRef: `job-input:${input.digest}`,
      });
      if (!existing?.equals(input.content)) throw new Error("InputDigestMismatch");
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { resourceRef: `job-input:${input.digest}` };
  },

  async read(input) {
    const match = REF.exec(input.resourceRef);
    if (!match) throw new Error("JobInputReferenceInvalid");
    const root = rootForTenant(input.tenantId);
    if (!(await assertStorageDirectories(root, false))) return null;
    const digestHex = match[1];
    if (!digestHex) throw new Error("JobInputReferenceInvalid");
    const target = join(root, digestHex);
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("JobInputStoragePathInvalid");
    return readFile(target);
  },
};
