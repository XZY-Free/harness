import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWorkspaceHostBroker, listenWorkspaceHostRpc } from "../workspace-host-server";

const [hostRoot, managedRoot, barrierRoot] = process.argv.slice(2);
if (!hostRoot || !managedRoot || !barrierRoot) {
  throw new Error("delayed-freeze RPC child 缺少目录参数");
}

await mkdir(barrierRoot, { recursive: true });
const enteredPath = path.join(barrierRoot, "entered");
const releasePath = path.join(barrierRoot, "release");
const broker = createWorkspaceHostBroker({
  root: hostRoot,
  managedRoot,
  testHooks: {
    async beforeFreezeScopeLock() {
      await writeFile(enteredPath, "entered", "utf8");
      for (;;) {
        if (
          await stat(releasePath).then(
            () => true,
            () => false,
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  },
});
const server = await listenWorkspaceHostRpc({ broker });
await writeFile(path.join(barrierRoot, "ready"), server.url, "utf8");
