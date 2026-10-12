/**
 * R07：受管 Environment 真实实例 Backend。
 *
 * 职责（repairs/06-environment.md §2/§5）：
 * - 生产 Provider 必须调用现有 Host/Container 管理能力**实际建立资源**，
 *   并从真实回读（docker inspect / 真实 Host 探测）中产出可核验实例事实。
 * - 固定镜像 digest 与入口，验证实际容器配置、资源限额、挂载/进程隔离、
 *   网络规则与 Secret 注入方式；不能用 Probe 返回 `true` 代替实际配置检查。
 * - 要求的策略无法落实时返回 `EnvironmentComplianceFailed`，不自报通过。
 * - 资源创建前先登记稳定的候选 operation/manifest 归属，Crash 后可按 operation
 *   查询，不重复创建无主资源。
 *
 * 本模块**不做**任何"策略默认值"假设——策略全部来自 `EnvironmentInstanceSpec`
 * （即冻结 Revision）。任何判定为 `satisfied:false` 的策略都会让 provision 失败。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EnvironmentComplianceError,
  EnvironmentInstanceMissingError,
  EnvironmentInstanceOperationError,
} from "@/lib/environment/environment-errors";
import {
  type EnvironmentInstanceSpec,
  computeInstanceTargetDigest,
  computeSpecDigest,
  derivedCapabilities,
} from "@/lib/environment/environment-instance-spec";
import type {
  EnvironmentInstanceIdentity,
  EnvironmentPolicyCheck,
  EnvironmentResourceManifestEntry,
} from "@/lib/environment/environment-prepared-evidence";
import {
  type DockerContainerInspect,
  inspectContainer,
  inspectImage,
  removeContainer,
  runManagedContainer,
} from "@/lib/runtime/container/docker-cli";

// ─── Backend 契约 ────────────────────────────────────────

export interface EnvironmentInstanceRequest {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  leaseId: string;
  /** 稳定 operation：同一逻辑实例化重试必须复用同一个 operationId。 */
  operationId: string;
  spec: EnvironmentInstanceSpec;
  /** 受管写根（Workspace 真实路径）；由 WorkspaceBinding 决定，不来自 Revision。 */
  workspaceRoot: string | null;
  /** 恢复水位（Prepared 证据的 Anchor 关联）。 */
  recoveryAnchorDigest: string | null;
  workspaceBindingId: string;
}

export interface EnvironmentInstanceFacts {
  identity: EnvironmentInstanceIdentity;
  /** 由真实实例配置派生，而不是 Revision 声明值。 */
  actualTargetDigest: string;
  verifier: { kind: string; ref: string; digest: string };
  policyChecks: EnvironmentPolicyCheck[];
  /** 由真实核验结果派生的能力事实（不接受调用方自报）。 */
  capabilities: Record<string, unknown>;
  resources: EnvironmentResourceManifestEntry[];
  /** 实例操作记录（Write-Ahead），崩溃后可按 operationId 回读。 */
  operation: EnvironmentOperationRecord;
}

export interface EnvironmentOperationRecord {
  operationId: string;
  tenantId: string;
  leaseId: string;
  attemptId: string;
  revisionId: string;
  backendKind: "container" | "host_agent";
  specDigest: string;
  /** 已声明的资源（创建前登记，创建后补全 identity）。 */
  resources: EnvironmentResourceManifestEntry[];
  state: "pending" | "created" | "released" | "release_failed";
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentReleaseReceipt {
  released: boolean;
  resources: EnvironmentResourceManifestEntry[];
  detail: string;
}

/**
 * 真实实例 Backend 端口。实现可以是 container（docker）或 host_agent（受管 Agent 制品）。
 */
export interface EnvironmentInstanceBackend {
  readonly kind: "container" | "host_agent";
  /** 真实创建实例并回读核验。创建前登记 operation 归属。 */
  create(input: EnvironmentInstanceRequest): Promise<EnvironmentInstanceFacts>;
  /** 真实回读既有实例（revalidate 用）。 */
  inspect(input: EnvironmentInstanceRequest): Promise<EnvironmentInstanceFacts>;
  /** 真实释放实例资源。 */
  release(input: {
    tenantId: string;
    leaseId: string;
    operationId: string;
    resources?: EnvironmentResourceManifestEntry[];
  }): Promise<EnvironmentReleaseReceipt>;
  /** Crash 后按 operation 查询归属（幂等创建的依据）。 */
  queryOperation(operationId: string): Promise<EnvironmentOperationRecord | null>;
}

// ─── Operation 归属登记（文件系统，进程崩溃可回读）──────────

function safeComponent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultEnvironmentControlRoot(): string {
  return (
    process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT?.trim() ||
    path.join(tmpdir(), "snowharness-environment")
  );
}

export class EnvironmentOperationRegistry {
  constructor(private readonly root: string) {}

  private file(operationId: string): string {
    return path.join(this.root, "operations", `${safeComponent(operationId)}.json`);
  }

  async write(record: EnvironmentOperationRecord): Promise<void> {
    await mkdir(path.dirname(this.file(record.operationId)), { recursive: true });
    const staging = `${this.file(record.operationId)}.${process.pid}.staging`;
    await writeFile(staging, JSON.stringify(record, null, 2), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(staging, this.file(record.operationId));
  }

  async read(operationId: string): Promise<EnvironmentOperationRecord | null> {
    try {
      const raw = await readFile(this.file(operationId), "utf8");
      return JSON.parse(raw) as EnvironmentOperationRecord;
    } catch {
      return null;
    }
  }

  async remove(operationId: string): Promise<void> {
    await rm(this.file(operationId), { force: true });
  }
}

// ─── 通用工具 ────────────────────────────────────────────

async function resolveReal(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function check(
  policy: EnvironmentPolicyCheck["policy"],
  required: unknown,
  actual: unknown,
  satisfied: boolean,
  ref: string,
): EnvironmentPolicyCheck {
  return {
    policy,
    required,
    actual,
    satisfied,
    check: { kind: "instance_probe", ref, digest: computeSpecDigest({ policy, required, actual }) },
  };
}

// ─── Container Backend（真实 docker）─────────────────────

export interface ContainerEnvironmentBackendDeps {
  /** 控制面根：operation 登记与 secret env 文件落盘处（不得位于受管写根内）。 */
  controlRoot?: string;
  /**
   * secret 解析。未提供或解析不到声明值 → 该策略 `satisfied:false`（fail closed），
   * 不会退化为"跳过注入但仍声称已注入"。
   */
  resolveSecrets?: (input: {
    tenantId: string;
    leaseId: string;
    revisionId: string;
    envNames: string[];
  }) => Promise<Record<string, string>>;
  registry?: EnvironmentOperationRegistry;
}

function containerName(operationId: string): string {
  return `snow-env-${safeComponent(operationId).slice(0, 40)}`;
}

/**
 * 受管容器的确定性名字（由稳定 operationId 派生）。
 *
 * 导出给"创建失败后的清理登记"使用：创建可能失败在容器已存在之后，
 * 清理必须能算回真实容器名，而不是拿 operationId 当 ref 去 inspect。
 */
export function managedContainerName(operationId: string): string {
  return containerName(operationId);
}

export function createContainerEnvironmentBackend(
  deps: ContainerEnvironmentBackendDeps = {},
): EnvironmentInstanceBackend {
  // 控制面根必须在 registry 与 secret 落盘之间**同一份**：两处各自解析会
  // 让 operation 归属与 secret 文件落到不同目录（Crash 后回读不一致）。
  const controlRoot = deps.controlRoot ?? defaultEnvironmentControlRoot();
  const registry = deps.registry ?? new EnvironmentOperationRegistry(controlRoot);

  async function declareOperation(
    input: EnvironmentInstanceRequest,
    state: EnvironmentOperationRecord["state"],
    resources: EnvironmentResourceManifestEntry[],
  ): Promise<EnvironmentOperationRecord> {
    const existing = await registry.read(input.operationId);
    const now = new Date().toISOString();
    const record: EnvironmentOperationRecord = {
      operationId: input.operationId,
      tenantId: input.tenantId,
      leaseId: input.leaseId,
      attemptId: input.attemptId,
      revisionId: input.spec.revisionId,
      backendKind: "container",
      specDigest: computeSpecDigest(input.spec),
      resources,
      state,
      lastErrorCode: existing?.lastErrorCode ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await registry.write(record);
    return record;
  }

  async function verify(
    input: EnvironmentInstanceRequest,
    inspected: DockerContainerInspect,
    imageId: string,
    expectedOperation: EnvironmentOperationRecord,
    secretEnvFile: string | null,
    secretValues: Record<string, string>,
  ): Promise<EnvironmentInstanceFacts> {
    const spec = input.spec;
    const container = spec.container;
    if (!container) throw new EnvironmentComplianceError("container Backend 收到非 container 规格");
    const name = containerName(input.operationId);

    // 1. executionTarget：固定镜像 + 固定入口 + 运行中
    const imageMatches =
      inspected.Image === imageId ||
      (await inspectImage(container.image))?.RepoDigests?.includes(container.image) === true;
    const expectedEntrypoint = [container.entrypoint[0]];
    const expectedCmd = [...container.entrypoint.slice(1), ...container.args];
    const entrypointMatches =
      JSON.stringify(inspected.Config.Entrypoint ?? []) === JSON.stringify(expectedEntrypoint);
    const cmdMatches = JSON.stringify(inspected.Config.Cmd ?? []) === JSON.stringify(expectedCmd);
    const targetCheck = check(
      "executionTarget",
      {
        image: container.image,
        imageDigest: container.imageDigest,
        entrypoint: container.entrypoint,
        args: container.args,
      },
      {
        imageId: inspected.Image,
        resolvedImageId: imageId,
        entrypoint: inspected.Config.Entrypoint ?? [],
        cmd: inspected.Config.Cmd ?? [],
        running: inspected.State.Running,
      },
      imageMatches && entrypointMatches && cmdMatches && inspected.State.Running,
      `docker inspect ${name}`,
    );

    // 2. filesystemPolicy：只读 rootfs + 受管写根挂载 + 隔离性
    const declaredMounts = [
      ...(spec.filesystemPolicy.workspaceMount && input.workspaceRoot
        ? [{ source: input.workspaceRoot, target: spec.filesystemPolicy.workspaceMount.target }]
        : []),
      ...spec.filesystemPolicy.extraMounts.map((mount) => ({
        source: mount.source,
        target: mount.target,
      })),
    ];
    const actualMounts = await Promise.all(
      inspected.Mounts.map(async (mount) => ({
        source: await resolveReal(mount.Source),
        target: mount.Destination,
        readOnly: !mount.RW,
      })),
    );
    const resolvedDeclared = await Promise.all(
      declaredMounts.map(async (mount) => ({
        source: await resolveReal(mount.source),
        target: mount.target,
      })),
    );
    const roMatches = inspected.HostConfig.ReadonlyRootfs === spec.filesystemPolicy.readOnlyRootfs;
    const workspaceMountOk = spec.filesystemPolicy.workspaceMount
      ? actualMounts.some(
          (mount) =>
            mount.target === spec.filesystemPolicy.workspaceMount?.target &&
            mount.readOnly === spec.filesystemPolicy.workspaceMount?.readOnly &&
            resolvedDeclared.some(
              (declared) => declared.target === mount.target && declared.source === mount.source,
            ),
        )
      : true;
    const extraMountsOk = spec.filesystemPolicy.extraMounts.every((mount) =>
      actualMounts.some(
        (actual) => actual.target === mount.target && actual.readOnly === mount.readOnly,
      ),
    );
    const hostIsolationOk = spec.filesystemPolicy.isolatedFromHost
      ? actualMounts.every((mount) =>
          resolvedDeclared.some((declared) => declared.source === mount.source),
        )
      : true;
    const filesystemCheck = check(
      "filesystemPolicy",
      spec.filesystemPolicy,
      {
        readOnlyRootfs: inspected.HostConfig.ReadonlyRootfs,
        mounts: actualMounts,
      },
      roMatches && workspaceMountOk && extraMountsOk && hostIsolationOk,
      `docker inspect ${name} .HostConfig.ReadonlyRootfs/.Mounts`,
    );

    // 3. networkPolicy：真实 NetworkMode
    const networkActual = inspected.HostConfig.NetworkMode;
    const networkOk =
      spec.networkPolicy.mode === "disabled" ? networkActual === "none" : networkActual !== "none";
    const networkCheck = check(
      "networkPolicy",
      spec.networkPolicy,
      { networkMode: networkActual },
      networkOk,
      `docker inspect ${name} .HostConfig.NetworkMode`,
    );

    // 4. resourceLimits：真实 cgroup 限额
    const limits = spec.resourceLimits;
    if (limits.diskQuotaBytes > 0) {
      // 容器 rootfs 磁盘配额需要 overlay2 配额支持，当前实现不核验 → fail closed，
      // 不允许"声明了但没核验"。
      throw new EnvironmentComplianceError(
        "resourceLimits.diskQuotaBytes 当前实现无法通过真实回读核验，拒绝自报通过",
      );
    }
    const nofileUlimit = (inspected.HostConfig.Ulimits ?? []).find((u) => u.Name === "nofile");
    const memoryOk = limits.memoryBytes === 0 || inspected.HostConfig.Memory === limits.memoryBytes;
    const cpuOk = limits.nanoCpus === 0 || inspected.HostConfig.NanoCpus === limits.nanoCpus;
    const pidsOk = limits.pidsLimit === 0 || inspected.HostConfig.PidsLimit === limits.pidsLimit;
    const nofileOk =
      limits.openFilesLimit === 0 ||
      (nofileUlimit?.Soft === limits.openFilesLimit &&
        nofileUlimit?.Hard === limits.openFilesLimit);
    const resourceCheck = check(
      "resourceLimits",
      limits,
      {
        memory: inspected.HostConfig.Memory,
        nanoCpus: inspected.HostConfig.NanoCpus,
        pidsLimit: inspected.HostConfig.PidsLimit,
        nofile: nofileUlimit ? { soft: nofileUlimit.Soft, hard: nofileUlimit.Hard } : null,
      },
      memoryOk && cpuOk && pidsOk && nofileOk,
      `docker inspect ${name} .HostConfig.Memory/NanoCpus/PidsLimit/Ulimits`,
    );

    // 5. secretPolicy：注入方式真实生效 + 不泄漏到命令行/标签
    const configuredEnv = inspected.Config.Env ?? [];
    const envNamesPresent = spec.secretPolicy.envNames.every((name) =>
      configuredEnv.some((entry) => entry.startsWith(`${name}=`)),
    );
    const commandLineLeak = spec.secretPolicy.envNames.some(
      (name) =>
        (inspected.Config.Cmd ?? []).some((arg) => arg.includes(name)) ||
        (inspected.Config.Entrypoint ?? []).some((arg) => arg.includes(name)) ||
        Object.values(inspected.Config.Labels ?? {}).some((value) => value.includes("=")),
    );
    const valueLeak = Object.values(secretValues).some(
      (value) =>
        value.length > 0 &&
        ((inspected.Config.Cmd ?? []).some((arg) => arg.includes(value)) ||
          (inspected.Config.Entrypoint ?? []).some((arg) => arg.includes(value))),
    );
    const secretInjectionOk =
      spec.secretPolicy.injection === "none"
        ? spec.secretPolicy.envNames.length === 0
        : envNamesPresent && !commandLineLeak && !valueLeak;
    const secretCheck = check(
      "secretPolicy",
      spec.secretPolicy,
      {
        injection: spec.secretPolicy.injection,
        injectedNames: spec.secretPolicy.envNames.filter((name) =>
          configuredEnv.some((entry) => entry.startsWith(`${name}=`)),
        ),
        envFile: secretEnvFile ? path.basename(secretEnvFile) : null,
        valueLeakedToCommandLine: valueLeak,
      },
      secretInjectionOk,
      `docker inspect ${name} .Config.Env/.Config.Cmd`,
    );

    // 6. processIsolation：非特权 + 独立 PID namespace
    const processOk = !inspected.HostConfig.Privileged && inspected.HostConfig.PidMode === "";
    const processCheck = check(
      "processIsolation",
      { privileged: false, pidMode: "container" },
      {
        privileged: inspected.HostConfig.Privileged,
        pidMode: inspected.HostConfig.PidMode || "private",
      },
      processOk,
      `docker inspect ${name} .HostConfig.Privileged/PidMode`,
    );

    const policyChecks = [
      targetCheck,
      filesystemCheck,
      networkCheck,
      resourceCheck,
      secretCheck,
      processCheck,
    ];
    const failure = policyChecks.filter((entry) => !entry.satisfied);
    if (failure.length > 0) {
      throw new EnvironmentComplianceError(
        `实际容器配置不满足 Revision 策略：${failure.map((entry) => entry.policy).join(", ")}`,
      );
    }

    const actualTargetDigest = computeInstanceTargetDigest({
      image: container.image,
      imageId: inspected.Image,
      entrypoint: inspected.Config.Entrypoint ?? [],
      cmd: inspected.Config.Cmd ?? [],
      resourceLimits: {
        memory: inspected.HostConfig.Memory,
        nanoCpus: inspected.HostConfig.NanoCpus,
        pidsLimit: inspected.HostConfig.PidsLimit,
        nofile: nofileUlimit ?? null,
      },
      networkMode: inspected.HostConfig.NetworkMode,
      readOnlyRootfs: inspected.HostConfig.ReadonlyRootfs,
      mounts: actualMounts,
      secretNames: spec.secretPolicy.envNames,
      backendKind: "container",
    });
    const verifier = {
      kind: "docker_inspect",
      ref: name,
      digest: computeSpecDigest({
        id: inspected.Id,
        config: inspected.Config,
        hostConfig: inspected.HostConfig,
        mounts: actualMounts,
        state: inspected.State,
      }),
    };
    return {
      identity: {
        workerRef: name,
        deviceId: null,
        hostIdentity: `container-host:${safeComponent(input.tenantId).slice(0, 24)}`,
        // 受管容器的"存储身份"就是它被固定的镜像身份（`sha256:<64hex>`，71 字符，
        // 正好等于列宽上限；带前缀会溢出 ER_DATA_TOO_LONG）。
        storageIdentity: inspected.Image,
        backendKind: "container",
      },
      actualTargetDigest,
      verifier,
      policyChecks,
      capabilities: derivedCapabilities({
        spec,
        readOnly: inspected.HostConfig.ReadonlyRootfs,
        networkIsolated: inspected.HostConfig.NetworkMode === "none",
        memoryLimited: inspected.HostConfig.Memory > 0,
        cpuLimited: inspected.HostConfig.NanoCpus > 0,
        pidsLimited: (inspected.HostConfig.PidsLimit ?? 0) > 0,
        openFilesLimited: Boolean(nofileUlimit),
        secretInjected: spec.secretPolicy.injection === "env_file" && envNamesPresent && !valueLeak,
        processIsolated: processOk,
        imagePinned: imageMatches,
      }),
      resources: expectedOperation.resources,
      operation: expectedOperation,
    };
  }

  async function materialize(
    input: EnvironmentInstanceRequest,
    options: { create: boolean },
  ): Promise<EnvironmentInstanceFacts> {
    const spec = input.spec;
    if (spec.backendKind !== "container" || !spec.container) {
      throw new EnvironmentComplianceError("container Backend 只接受 backendKind=container 的规格");
    }
    const name = containerName(input.operationId);
    const resource: EnvironmentResourceManifestEntry = {
      kind: "container",
      ref: name,
      identity: `pending:${computeSpecDigest(spec).slice(7, 23)}`,
    };

    // Write-Ahead：先登记 operation 归属，再创建资源（Crash 后可按 operation 回读）。
    let operation = await registry.read(input.operationId);
    if (!operation) {
      operation = await declareOperation(input, "pending", [resource]);
    } else if (
      operation.revisionId !== spec.revisionId ||
      operation.specDigest !== computeSpecDigest(spec) ||
      operation.tenantId !== input.tenantId ||
      operation.leaseId !== input.leaseId
    ) {
      throw new EnvironmentInstanceOperationError(
        `operation ${input.operationId} 已归属其他 Revision/Lease，拒绝复用`,
        "create",
      );
    }

    // secret 解析 + 落盘（env-file 不写命令行）。
    let secretEnvFile: string | null = null;
    const secretValues: Record<string, string> = {};
    if (spec.secretPolicy.injection === "env_file" && spec.secretPolicy.envNames.length > 0) {
      const resolved =
        (await deps.resolveSecrets?.({
          tenantId: input.tenantId,
          leaseId: input.leaseId,
          revisionId: spec.revisionId,
          envNames: spec.secretPolicy.envNames,
        })) ?? {};
      const missing = spec.secretPolicy.envNames.filter((key) => !resolved[key]);
      if (missing.length > 0) {
        throw new EnvironmentComplianceError(
          `secretPolicy 声明注入但解析不到值：${missing.join(", ")}`,
        );
      }
      for (const key of spec.secretPolicy.envNames) {
        const value = resolved[key];
        if (value === undefined) {
          throw new EnvironmentComplianceError(`secretPolicy 声明注入但解析不到值：${key}`);
        }
        secretValues[key] = value;
      }
      const secretsDir = path.join(controlRoot, "secrets");
      await mkdir(secretsDir, { recursive: true });
      secretEnvFile = path.join(secretsDir, `${safeComponent(input.operationId).slice(0, 32)}.env`);
      await writeFile(
        secretEnvFile,
        `${Object.entries(secretValues)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      // secret 文件不得位于受管写根内（否则 Workspace 侧可读到）。
      if (input.workspaceRoot) {
        const realSecret = await resolveReal(secretEnvFile);
        const realWorkspace = await resolveReal(input.workspaceRoot);
        if (realSecret.startsWith(`${realWorkspace}${path.sep}`)) {
          throw new EnvironmentComplianceError("secret env 文件不得位于受管写根内");
        }
      }
    }

    if (options.create) {
      const existing = await inspectContainer(name);
      if (existing) {
        // 幂等重放：同名容器已存在且归属本 operation → 不重复创建，直接回读核验。
        const image = await inspectImage(spec.container.image);
        const imageId = image?.Id ?? existing.Image;
        const facts = await verify(
          input,
          existing,
          imageId,
          operation,
          secretEnvFile,
          secretValues,
        );
        const created = await declareOperation(input, "created", [
          { ...resource, identity: existing.Image },
        ]);
        return { ...facts, operation: created, resources: created.resources };
      }
      const needsWorkspaceMount = Boolean(spec.filesystemPolicy.workspaceMount);
      if (needsWorkspaceMount && !input.workspaceRoot) {
        throw new EnvironmentComplianceError(
          "filesystemPolicy.workspaceMountPath 已声明，但本次没有受管写根可挂载",
        );
      }
      const resolvedImage = await inspectImage(spec.container.image);
      if (!resolvedImage) {
        throw new EnvironmentInstanceOperationError(
          `executionTarget.image 在受管 Host 上不存在：${spec.container.image}（必须先固定镜像 digest）`,
          "create",
        );
      }
      const pinnedOk =
        resolvedImage.Id === spec.container.imageDigest ||
        (resolvedImage.RepoDigests ?? []).includes(spec.container.image);
      if (!pinnedOk) {
        throw new EnvironmentComplianceError(
          `executionTarget.imageDigest 与宿主实际镜像不一致（期望 ${spec.container.imageDigest}，实际 ${resolvedImage.Id}）`,
        );
      }
      const mounts: Array<{ source: string; target: string; readOnly: boolean }> = [];
      if (spec.filesystemPolicy.workspaceMount && input.workspaceRoot) {
        await mkdir(input.workspaceRoot, { recursive: true });
        mounts.push({
          source: await resolveReal(input.workspaceRoot),
          target: spec.filesystemPolicy.workspaceMount.target,
          readOnly: spec.filesystemPolicy.workspaceMount.readOnly,
        });
      }
      for (const mount of spec.filesystemPolicy.extraMounts) mounts.push(mount);

      await removeContainer(name); // 清理同名孤儿（不属于本 operation 的残留由 registry 判定）
      const containerId = await runManagedContainer({
        name,
        image: spec.container.image,
        entrypoint: spec.container.entrypoint,
        args: spec.container.args,
        labels: {
          "snow-harness.environment.operationId": input.operationId,
          "snow-harness.environment.leaseId": input.leaseId,
          "snow-harness.environment.tenantId": input.tenantId,
          "snow-harness.environment.revisionId": spec.revisionId,
        },
        memoryBytes: spec.resourceLimits.memoryBytes,
        nanoCpus: spec.resourceLimits.nanoCpus,
        pidsLimit: spec.resourceLimits.pidsLimit,
        openFilesLimit: spec.resourceLimits.openFilesLimit,
        readOnlyRootfs: spec.filesystemPolicy.readOnlyRootfs,
        networkMode: spec.networkPolicy.mode === "disabled" ? "none" : undefined,
        mounts,
        workdir: spec.container.workdir ?? undefined,
        envFilePath: secretEnvFile ?? undefined,
      });
      operation = await declareOperation(input, "pending", [{ ...resource, ref: containerId }]);
    }

    const inspected = await inspectContainer(name);
    if (!inspected) {
      throw new EnvironmentInstanceMissingError(`受管容器不存在：${name}`);
    }
    const image = await inspectImage(spec.container.image);
    const imageId = image?.Id ?? inspected.Image;
    const facts = await verify(input, inspected, imageId, operation, secretEnvFile, secretValues);
    const completed = await declareOperation(input, "created", [
      { kind: "container", ref: name, identity: inspected.Image },
    ]);
    return { ...facts, operation: completed, resources: completed.resources };
  }

  return {
    kind: "container",
    async create(input) {
      return materialize(input, { create: true });
    },
    async inspect(input) {
      return materialize(input, { create: false });
    },
    async release(input) {
      const operation = await registry.read(input.operationId);
      const resources = input.resources ?? operation?.resources ?? [];
      const containerResource = resources.find((entry) => entry.kind === "container");
      const name = containerResource?.ref ?? containerName(input.operationId);
      const before = await inspectContainer(name);
      if (before) {
        await removeContainer(name);
        const after = await inspectContainer(name);
        if (after) {
          const failed: EnvironmentOperationRecord = {
            operationId: input.operationId,
            tenantId: input.tenantId,
            leaseId: input.leaseId,
            attemptId: operation?.attemptId ?? "",
            revisionId: operation?.revisionId ?? "",
            backendKind: "container",
            specDigest: operation?.specDigest ?? "",
            resources,
            state: "release_failed",
            lastErrorCode: "ContainerStillPresent",
            createdAt: operation?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await registry.write(failed);
          throw new EnvironmentInstanceOperationError(`受管容器释放后仍然存在：${name}`, "release");
        }
      }
      const released: EnvironmentOperationRecord = {
        operationId: input.operationId,
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        attemptId: operation?.attemptId ?? "",
        revisionId: operation?.revisionId ?? "",
        backendKind: "container",
        specDigest: operation?.specDigest ?? "",
        resources,
        state: "released",
        lastErrorCode: null,
        createdAt: operation?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await registry.write(released);
      return {
        released: true,
        resources,
        detail: before ? `container ${name} removed` : `container ${name} already absent`,
      };
    },
    async queryOperation(operationId) {
      return registry.read(operationId);
    },
  };
}

// ─── Host Agent Backend（受管 Agent 制品 + 真实 Host 身份）────

export interface HostAgentEnvironmentBackendDeps {
  /** 真实 Host 身份探测（生产默认复用受管 WorkspaceHost 的持久化身份记录）。 */
  probeHost: (root: string) => Promise<{
    hostIdentity: string;
    storageIdentity: string;
    deviceId: string | null;
    canonicalRoot: string;
  }>;
  registry?: EnvironmentOperationRegistry;
  controlRoot?: string;
}

/**
 * host_agent Backend：固定受管 Agent 制品，并**只声明该 Backend 确实能执行的策略**。
 *
 * 诚实边界（不伪装）：
 * - 进程隔离：平台进程与 Agent 同属宿主，无法硬隔离 → `processIsolation:false`。
 * - 网络隔离：宿主进程 egress 不可硬隔离 → `networkIsolation:false`。
 * - 只读 rootfs / 资源 cgroup 限额 / 宿主路径隔离：宿主进程不提供 → 对应检查 false。
 * - 受管 Agent 制品 + 真实 Host 身份：能落实（真实文件摘要 + 真实 dev/inode 探测）。
 *
 * 因此任何要求网络/隔离/资源限额的 Revision 在 host_agent 上都会 fail closed。
 */
export function createHostAgentEnvironmentBackend(
  deps: HostAgentEnvironmentBackendDeps,
): EnvironmentInstanceBackend {
  const registry =
    deps.registry ??
    new EnvironmentOperationRegistry(deps.controlRoot ?? defaultEnvironmentControlRoot());

  async function verifyArtifact(
    input: EnvironmentInstanceRequest,
  ): Promise<{ digest: string; bytes: number }> {
    const target = input.spec.hostAgent;
    if (!target) throw new EnvironmentComplianceError("host_agent Backend 收到非 host_agent 规格");
    let buffer: Buffer;
    try {
      buffer = await readFile(target.artifactRef);
    } catch {
      throw new EnvironmentInstanceOperationError(
        `受管 Agent 制品不存在：${target.artifactRef}（host_agent 必须固定受管制品）`,
        "create",
      );
    }
    const digest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    if (digest !== target.artifactDigest) {
      throw new EnvironmentComplianceError(
        `受管 Agent 制品摘要不匹配（期望 ${target.artifactDigest}，实际 ${digest}）`,
      );
    }
    return { digest, bytes: buffer.byteLength };
  }

  async function buildFacts(input: EnvironmentInstanceRequest): Promise<EnvironmentInstanceFacts> {
    const spec = input.spec;
    const target = spec.hostAgent;
    if (!target) throw new EnvironmentComplianceError("host_agent Backend 收到非 host_agent 规格");
    const agentRoot = input.workspaceRoot ?? path.dirname(target.artifactRef);
    const host = await deps.probeHost(agentRoot);
    const artifact = await verifyArtifact(input);
    const operation =
      (await registry.read(input.operationId)) ??
      (await (async () => {
        const now = new Date().toISOString();
        const record: EnvironmentOperationRecord = {
          operationId: input.operationId,
          tenantId: input.tenantId,
          leaseId: input.leaseId,
          attemptId: input.attemptId,
          revisionId: spec.revisionId,
          backendKind: "host_agent",
          specDigest: computeSpecDigest(spec),
          resources: [
            { kind: "host_agent_artifact", ref: target.artifactRef, identity: artifact.digest },
          ],
          state: "created",
          lastErrorCode: null,
          createdAt: now,
          updatedAt: now,
        };
        await registry.write(record);
        return record;
      })());

    // host_agent 的诚实能力声明：只 claim 真实可核验的事实。
    const filesystemCheck = check(
      "filesystemPolicy",
      spec.filesystemPolicy,
      {
        readOnlyRootfs: false,
        workspaceMount: spec.filesystemPolicy.workspaceMount ? "host-directory" : null,
        isolatedFromHost: false,
      },
      !spec.filesystemPolicy.readOnlyRootfs &&
        spec.filesystemPolicy.extraMounts.length === 0 &&
        !spec.filesystemPolicy.isolatedFromHost,
      `host_agent probe ${host.canonicalRoot}`,
    );
    const networkCheck = check(
      "networkPolicy",
      spec.networkPolicy,
      { mode: "open", enforced: false },
      spec.networkPolicy.mode === "open",
      `host_agent probe ${host.canonicalRoot}`,
    );
    const resourceCheck = check(
      "resourceLimits",
      spec.resourceLimits,
      { memoryBytes: 0, nanoCpus: 0, cgroupEnforced: false },
      spec.resourceLimits.memoryBytes === 0 &&
        spec.resourceLimits.nanoCpus === 0 &&
        spec.resourceLimits.pidsLimit === 0 &&
        spec.resourceLimits.openFilesLimit === 0 &&
        spec.resourceLimits.diskQuotaBytes === 0,
      `host_agent probe ${host.canonicalRoot}`,
    );
    const secretCheck = check(
      "secretPolicy",
      spec.secretPolicy,
      { injection: "none" },
      spec.secretPolicy.injection === "none" && spec.secretPolicy.envNames.length === 0,
      `host_agent probe ${host.canonicalRoot}`,
    );
    const targetCheck = check(
      "executionTarget",
      {
        artifactRef: target.artifactRef,
        artifactDigest: target.artifactDigest,
        agentCommand: target.agentCommand,
      },
      { artifactDigest: artifact.digest, bytes: artifact.bytes, canonicalRoot: host.canonicalRoot },
      true,
      `host_agent artifact ${target.artifactRef}`,
    );
    const processCheck = check(
      "processIsolation",
      { processIsolation: true },
      { processIsolation: false, sharedHostKernel: true },
      false,
      `host_agent probe ${host.canonicalRoot}`,
    );
    const policyChecks = [
      targetCheck,
      filesystemCheck,
      networkCheck,
      resourceCheck,
      secretCheck,
      processCheck,
    ];
    const actualTargetDigest = computeInstanceTargetDigest({
      artifactDigest: artifact.digest,
      agentCommand: target.agentCommand,
      canonicalRoot: host.canonicalRoot,
      hostIdentity: host.hostIdentity,
      backendKind: "host_agent",
    });
    return {
      identity: {
        workerRef: `host_agent:${host.hostIdentity}`,
        deviceId: host.deviceId,
        hostIdentity: host.hostIdentity,
        storageIdentity: host.storageIdentity,
        backendKind: "host_agent",
      },
      actualTargetDigest,
      verifier: {
        kind: "host_agent_probe",
        ref: host.canonicalRoot,
        digest: computeSpecDigest({
          hostIdentity: host.hostIdentity,
          artifactDigest: artifact.digest,
        }),
      },
      policyChecks,
      capabilities: derivedCapabilities({
        spec,
        readOnly: false,
        networkIsolated: false,
        memoryLimited: false,
        cpuLimited: false,
        pidsLimited: false,
        openFilesLimited: false,
        secretInjected: false,
        processIsolated: false,
        imagePinned: true,
      }),
      resources: operation.resources,
      operation,
    };
  }

  return {
    kind: "host_agent",
    async create(input) {
      const facts = await buildFacts(input);
      // 策略无法落实 → 在执行前 fail closed（不自报通过）。
      const failed = facts.policyChecks.filter((entry) => !entry.satisfied);
      if (failed.length > 0) {
        throw new EnvironmentComplianceError(
          `host_agent 无法落实的策略：${failed.map((entry) => entry.policy).join(", ")}`,
        );
      }
      return facts;
    },
    async inspect(input) {
      return buildFacts(input);
    },
    async release(input) {
      const operation = await registry.read(input.operationId);
      const resources = input.resources ??
        operation?.resources ?? [
          {
            kind: "host_agent_artifact",
            ref: input.operationId,
            identity: "unknown",
          },
        ];
      if (operation) {
        await registry.write({
          ...operation,
          state: "released",
          lastErrorCode: null,
          updatedAt: new Date().toISOString(),
        });
      }
      return { released: true, resources, detail: "host_agent lease released" };
    },
    async queryOperation(operationId) {
      return registry.read(operationId);
    },
  };
}

/** 真实 Host 身份探测（复用受管 WorkspaceHost Broker 的持久化身份）。 */
export async function probeManagedHostIdentity(root: string): Promise<{
  hostIdentity: string;
  storageIdentity: string;
  deviceId: string | null;
  canonicalRoot: string;
}> {
  const { createWorkspaceHostBroker } = await import("@/lib/workspace/workspace-host-server");
  const probe = await createWorkspaceHostBroker({ root }).probeIdentity();
  return {
    hostIdentity: probe.hostIdentity,
    storageIdentity: probe.storageIdentity,
    deviceId: null,
    canonicalRoot: probe.canonicalRoot,
  };
}

/** 默认生产 Backend 选择：container（平台默认）或 host_agent。 */
export function createDefaultEnvironmentInstanceBackend(input?: {
  runtimeType?: "host" | "container";
  controlRoot?: string;
  resolveSecrets?: ContainerEnvironmentBackendDeps["resolveSecrets"];
}): EnvironmentInstanceBackend {
  const runtimeType = input?.runtimeType ?? "container";
  if (runtimeType === "host") {
    return createHostAgentEnvironmentBackend({
      probeHost: (root) => probeManagedHostIdentity(root),
      ...(input?.controlRoot ? { controlRoot: input.controlRoot } : {}),
    });
  }
  return createContainerEnvironmentBackend({
    ...(input?.controlRoot ? { controlRoot: input.controlRoot } : {}),
    ...(input?.resolveSecrets ? { resolveSecrets: input.resolveSecrets } : {}),
  });
}

/** 目录存在性检查（诊断用）。 */
export async function environmentPathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
