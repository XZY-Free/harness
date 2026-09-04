import { createToolExecutionWorker } from "@/lib/capability/tool-execution-worker";

const worker = createToolExecutionWorker();

async function run(): Promise<void> {
  for (;;) {
    const result = await worker.runOnce();
    if (result === "idle") await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

void run();
