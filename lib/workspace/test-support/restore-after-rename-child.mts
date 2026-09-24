import { writeFile } from "node:fs/promises";
import { FileSnapshotStorage } from "../snapshot-storage.ts";
import { createWorkspaceHostBroker } from "../workspace-host-server.ts";

const [hostRoot, managedRoot, storageRoot, manifestRef, manifestDigest, destination, signalPath] =
  process.argv.slice(2);
if (
  !hostRoot ||
  !managedRoot ||
  !storageRoot ||
  !manifestRef ||
  !manifestDigest ||
  !destination ||
  !signalPath
) {
  throw new Error("restore-after-rename-child 缺少测试参数");
}

const storage = new FileSnapshotStorage(storageRoot, {
  async afterRestoreRename() {
    await writeFile(signalPath, "renamed", "utf8");
    await new Promise<void>(() => setInterval(() => undefined, 1_000));
  },
});
const broker = createWorkspaceHostBroker({ root: hostRoot, managedRoot, snapshotStorage: storage });
await broker.restore({ manifestRef, manifestDigest, destination, operationId: "restore-crash" });
