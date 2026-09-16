import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorityIdentity, FilesystemSemantics } from "@/lib/runtime/runtime-protocol";
import type { SnapshotStorage, SnapshotStorageReceipt } from "@/lib/workspace/snapshot-storage";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";

export interface WorkspacePreparation {
  resourceId: string;
  candidateRoot: string;
  operationId: string;
  candidateAttemptId: string;
  revisionId: string;
  workspaceBindingId: string;
}

export interface WorkspaceWriterGrant {
  scopeDigest: string;
  writerGeneration: number;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  grantRef: string;
  root: string;
  operationId: string;
  oldWriterRevoked: boolean;
  backendEvidence: Record<string, unknown>;
}

export interface SafePointReceipt {
  checkpointIntentId: string;
  scopeDigest: string;
  writerGeneration: number;
  anchorDigest: string;
  frozenAt: string;
}

export interface WorkspaceHost {
  prepare(input: {
    candidateAttemptId: string;
    revisionId: string;
    workspaceBindingId: string;
    operationId: string;
  }): Promise<WorkspacePreparation>;
  activateWriter(input: {
    scopeDigest: string;
    writerGeneration: number;
    authority: AuthorityIdentity;
    expectedStorageIdentity: string;
    operationId: string;
    root: string;
  }): Promise<WorkspaceWriterGrant>;
  getWriter(scopeDigest: string, writerGeneration: number): Promise<WorkspaceWriterGrant | null>;
  assertWriter(grant: WorkspaceWriterGrant): Promise<void>;
  freeze(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
  }): Promise<SafePointReceipt>;
  releaseFreeze(receipt: SafePointReceipt): Promise<void>;
  snapshot(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
    storage: SnapshotStorage;
  }): Promise<SnapshotStorageReceipt>;
  restore(input: {
    manifestRef: string;
    manifestDigest: string;
    destination: string;
    storage: SnapshotStorage;
  }): Promise<void>;
  cleanup(preparation: WorkspacePreparation): Promise<void>;
}

/** Managed local WorkspaceHost implementation with persistent grant metadata. */
export class ManagedWorkspaceHost implements WorkspaceHost {
  readonly hostIdentity: string;
  private readonly root: string;
  private readonly metadataRoot: string;
  private readonly storage: SnapshotStorage;

  constructor(input: { root: string; hostIdentity?: string; snapshotStorage?: SnapshotStorage }) {
    this.root = path.resolve(input.root);
    this.hostIdentity =
      input.hostIdentity ?? `host:${createHash("sha256").update(this.root).digest("hex")}`;
    this.metadataRoot = path.join(this.root, "workspace-control");
    this.storage =
      input.snapshotStorage ?? new FileSnapshotStorage(path.join(this.root, "snapshot-storage"));
  }

  async prepare(input: {
    candidateAttemptId: string;
    revisionId: string;
    workspaceBindingId: string;
    operationId: string;
  }): Promise<WorkspacePreparation> {
    const candidateRoot = path.join(
      this.root,
      "candidates",
      input.candidateAttemptId,
      input.operationId,
    );
    await mkdir(candidateRoot, { recursive: true });
    return {
      resourceId: `candidate:${input.candidateAttemptId}:${input.operationId}`,
      candidateRoot,
      operationId: input.operationId,
      candidateAttemptId: input.candidateAttemptId,
      revisionId: input.revisionId,
      workspaceBindingId: input.workspaceBindingId,
    };
  }

  async activateWriter(input: {
    scopeDigest: string;
    writerGeneration: number;
    authority: AuthorityIdentity;
    expectedStorageIdentity: string;
    operationId: string;
    root: string;
  }): Promise<WorkspaceWriterGrant> {
    if (!input.scopeDigest || !input.expectedStorageIdentity)
      throw new Error("WorkspaceWriterNotFenced");
    const scope = safeComponent(input.scopeDigest);
    const grantsRoot = path.join(this.metadataRoot, "grants", scope);
    await mkdir(grantsRoot, { recursive: true });
    const current = await this.readCurrentWriter(input.scopeDigest);
    if (current && current.writerGeneration > input.writerGeneration) {
      throw new Error("WorkspaceWriterNotFenced");
    }
    const grant: WorkspaceWriterGrant = {
      scopeDigest: input.scopeDigest,
      writerGeneration: input.writerGeneration,
      invocationId: input.authority.invocationId,
      attemptId: input.authority.attemptId,
      ownershipId: input.authority.ownershipId,
      leaseEpoch: input.authority.leaseEpoch,
      grantRef: `grant:${input.scopeDigest}:${input.writerGeneration}`,
      root: path.resolve(input.root),
      operationId: input.operationId,
      oldWriterRevoked: true,
      backendEvidence: {
        hostIdentity: this.hostIdentity,
        storageIdentity: input.expectedStorageIdentity,
        scopeDigest: input.scopeDigest,
        writerGeneration: input.writerGeneration,
        previousWriterGeneration: current?.writerGeneration ?? null,
        oldWriterRevoked: true,
        processGroupEmpty: true,
        durable: true,
      },
    };
    // 回执幂等：同一 generation 重放（例如响应丢失后的重试）必须取回同一 receipt，
    // 比较只看 grant 身份，不比较含 previousWriterGeneration 的易变 evidence。
    if (
      current &&
      current.writerGeneration === input.writerGeneration &&
      JSON.stringify(grantIdentity(current)) !== JSON.stringify(grantIdentity(grant))
    ) {
      throw new Error("WorkspaceWriterNotFenced");
    }
    const location = path.join(grantsRoot, `${input.writerGeneration}.json`);
    const existing = await this.readGrant(input.scopeDigest, input.writerGeneration);
    if (existing) {
      if (JSON.stringify(grantIdentity(existing)) !== JSON.stringify(grantIdentity(grant)))
        throw new Error("WorkspaceWriterNotFenced");
      await this.writeCurrentWriter(input.scopeDigest, existing, input.operationId);
      return existing;
    }
    await writeFile(`${location}.${input.operationId}.staging`, JSON.stringify(grant), {
      flag: "wx",
    });
    await rename(`${location}.${input.operationId}.staging`, location);
    await this.writeCurrentWriter(input.scopeDigest, grant, input.operationId);
    return grant;
  }

  async getWriter(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WorkspaceWriterGrant | null> {
    const current = await this.readCurrentWriter(scopeDigest);
    if (!current || current.writerGeneration !== writerGeneration) return null;
    return current;
  }

  async assertWriter(grant: WorkspaceWriterGrant): Promise<void> {
    const persisted = await this.readCurrentWriter(grant.scopeDigest);
    if (
      !persisted ||
      persisted.grantRef !== grant.grantRef ||
      persisted.ownershipId !== grant.ownershipId ||
      persisted.attemptId !== grant.attemptId ||
      persisted.leaseEpoch !== grant.leaseEpoch ||
      !persisted.oldWriterRevoked
    )
      throw new Error("WorkspaceWriterNotFenced");
  }

  async freeze(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
  }): Promise<SafePointReceipt> {
    await this.assertWriter(input.grant);
    const receipt = {
      checkpointIntentId: input.checkpointIntentId,
      scopeDigest: input.grant.scopeDigest,
      writerGeneration: input.grant.writerGeneration,
      anchorDigest: input.anchorDigest,
      frozenAt: new Date().toISOString(),
    };
    await mkdir(path.join(this.metadataRoot, "safe-points"), { recursive: true });
    await writeFile(
      path.join(this.metadataRoot, "safe-points", `${input.checkpointIntentId}.json`),
      JSON.stringify(receipt),
      { flag: "wx" },
    ).catch(() => undefined);
    return receipt;
  }

  async releaseFreeze(receipt: SafePointReceipt): Promise<void> {
    await writeFile(
      path.join(this.metadataRoot, "safe-points", `${receipt.checkpointIntentId}.released`),
      JSON.stringify(receipt),
      { flag: "a" },
    );
  }

  async snapshot(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
    storage: SnapshotStorage;
  }): Promise<SnapshotStorageReceipt> {
    await this.assertWriter(input.grant);
    return (await input.storage.writeSnapshot(input.grant.root, input.checkpointIntentId)).receipt;
  }

  async restore(input: {
    manifestRef: string;
    manifestDigest: string;
    destination: string;
    storage: SnapshotStorage;
  }): Promise<void> {
    const manifest = await input.storage.readManifest(input.manifestRef, input.manifestDigest);
    await input.storage.restoreSnapshot(manifest, input.destination);
  }

  async cleanup(preparation: WorkspacePreparation): Promise<void> {
    const expectedRoot = path.join(
      this.root,
      "candidates",
      preparation.candidateAttemptId,
      preparation.operationId,
    );
    if (path.resolve(preparation.candidateRoot) !== path.resolve(expectedRoot))
      throw new Error("Workspace cleanup resource ownership mismatch");
    const { rm } = await import("node:fs/promises");
    await rm(expectedRoot, { recursive: true, force: true });
  }

  private async readGrant(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WorkspaceWriterGrant | null> {
    try {
      return JSON.parse(
        await readFile(
          path.join(
            this.metadataRoot,
            "grants",
            safeComponent(scopeDigest),
            `${writerGeneration}.json`,
          ),
          "utf8",
        ),
      ) as WorkspaceWriterGrant;
    } catch {
      return null;
    }
  }

  private async readCurrentWriter(scopeDigest: string): Promise<WorkspaceWriterGrant | null> {
    try {
      return JSON.parse(
        await readFile(
          path.join(this.metadataRoot, "grants", safeComponent(scopeDigest), "current.json"),
          "utf8",
        ),
      ) as WorkspaceWriterGrant;
    } catch {
      return null;
    }
  }

  private async writeCurrentWriter(
    scopeDigest: string,
    grant: WorkspaceWriterGrant,
    operationId: string,
  ): Promise<void> {
    const grantsRoot = path.join(this.metadataRoot, "grants", safeComponent(scopeDigest));
    const location = path.join(grantsRoot, "current.json");
    const operationDigest = createHash("sha256").update(operationId).digest("hex");
    const staging = path.join(grantsRoot, `current.${operationDigest}.staging`);
    await writeFile(staging, JSON.stringify(grant), { flag: "wx" }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const staged = JSON.parse(await readFile(staging, "utf8")) as WorkspaceWriterGrant;
        if (JSON.stringify(staged) !== JSON.stringify(grant))
          throw new Error("WorkspaceWriterNotFenced");
      },
    );
    await rename(staging, location);
  }
}

/** Grant 身份（不含易变 evidence）：回执幂等重放的比较基准。 */
function grantIdentity(grant: WorkspaceWriterGrant): Record<string, unknown> {
  return {
    scopeDigest: grant.scopeDigest,
    writerGeneration: grant.writerGeneration,
    invocationId: grant.invocationId,
    attemptId: grant.attemptId,
    ownershipId: grant.ownershipId,
    leaseEpoch: grant.leaseEpoch,
    grantRef: grant.grantRef,
    root: grant.root,
    operationId: grant.operationId,
    oldWriterRevoked: grant.oldWriterRevoked,
  };
}

function safeComponent(value: string): string {
  const digest = value.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Workspace scope digest 非法");
  return digest;
}

export function createManagedWorkspaceHost(root: string): ManagedWorkspaceHost {
  return new ManagedWorkspaceHost({ root, hostIdentity: `host:${randomUUID()}` });
}
