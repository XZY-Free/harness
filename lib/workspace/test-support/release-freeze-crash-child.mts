import { readFile, writeFile } from "node:fs/promises";
import { createWorkspaceHostBroker } from "../workspace-host-server.ts";
import type { SafePointReceipt } from "../workspace-host.ts";

const [mode, hostRoot, managedRoot, receiptPath, signalPath] = process.argv.slice(2);
if (
  (mode !== "after_unlink" && mode !== "after_release") ||
  !hostRoot ||
  !managedRoot ||
  !receiptPath ||
  !signalPath
) {
  throw new Error("release-freeze-crash-child 缺少测试参数");
}

const hold = () => new Promise<void>(() => setInterval(() => undefined, 1_000));
const broker = createWorkspaceHostBroker({
  root: hostRoot,
  managedRoot,
  ...(mode === "after_unlink"
    ? {
        testHooks: {
          async afterReleaseBarrierRemoved() {
            await writeFile(signalPath, "unlinked", "utf8");
            await hold();
          },
        },
      }
    : {}),
});
const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as SafePointReceipt;
await broker.releaseFreeze(receipt);
if (mode === "after_release") {
  await writeFile(signalPath, "released", "utf8");
  await hold();
}
