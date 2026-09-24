import { writeFile } from "node:fs/promises";
import { protocolDigest } from "../../runtime/runtime-protocol.ts";
import { produceFilesystemCheckpoint } from "../checkpoint-producer.ts";
import { createWorkspaceBackend } from "../workspace-backend.ts";
import { createWorkspaceHostBroker } from "../workspace-host-server.ts";

const [
  tenantId,
  invocationId,
  ownershipId,
  checkpointIntentId,
  hostRoot,
  managedRoot,
  storageRoot,
  markerPath,
] = process.argv.slice(2);
if (
  !tenantId ||
  !invocationId ||
  !ownershipId ||
  !checkpointIntentId ||
  !hostRoot ||
  !managedRoot ||
  !storageRoot ||
  !markerPath
) {
  throw new Error("checkpoint-upload-crash-child 缺少测试参数");
}

const host = createWorkspaceHostBroker({ root: hostRoot, managedRoot });
const blockedHost = new Proxy(host, {
  get(target, property) {
    if (property === "snapshot") {
      return async (input: Parameters<typeof host.snapshot>[0]) => {
        const receipt = await host.snapshot(input);
        await writeFile(markerPath, JSON.stringify(receipt), "utf8");
        // 候选 manifest 已真实持久化；父进程在数据库正式提交前杀掉本进程。
        await new Promise<void>(() => setInterval(() => undefined, 1_000));
        return receipt;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

try {
  await produceFilesystemCheckpoint({
    tenantId,
    invocationId,
    ownershipId,
    checkpointIntentId,
    backend: createWorkspaceBackend(blockedHost),
    storage: { kind: "file", root: storageRoot },
    safePointEvidence: {
      checkpointIntentId,
      safePointEvidenceDigest: protocolDigest({ safePoint: checkpointIntentId }),
      writerQuiescenceAchievedAt: new Date(),
    },
  });
} catch (error) {
  await writeFile(`${markerPath}.error`, String(error), "utf8");
  throw error;
}
