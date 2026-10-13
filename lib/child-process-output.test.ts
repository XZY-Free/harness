/**
 * `drainChildProcessOutput` 与 `tolerateChannelPeerDeath` 的行为契约。
 *
 * 前三个用例锁定排空语义：
 * 1. 排空 = 流进入流动模式（避免管道写满卡住子进程）；
 * 2. 来源死亡引发的流错误按排空结束处理（不再逃逸）；
 * 3. 负向对照：未被排空的流遇到读错误会逃逸为 uncaughtException——
 *    这正是修复要消除的进程级缺口（Linux 上子进程被信号终止时可能触发）。
 *
 * 后两个用例锁定放行通道的对端死亡容忍（同一缺口在**写**通道上的形态）：
 * 4. 通道错误不再逃逸：wrapper 在读到令牌前被强杀时，Linux 会在读端给出
 *    `read ECONNRESET`，一次受控崩溃不得打翻整个进程；
 * 5. 负向对照：没有容忍的通道遇到同样的错误会逃逸。
 */
import { PassThrough } from "node:stream";
import { drainChildProcessOutput, tolerateChannelPeerDeath } from "@/lib/child-process-output";
import { describe, expect, it } from "vitest";

/** 在受控监听器下触发一次「异步读错误」，返回被捕获的 uncaughtException。 */
async function catchUncaught(trigger: () => void): Promise<unknown[]> {
  const caught: unknown[] = [];
  const listener = (error: unknown): void => {
    caught.push(error);
  };
  process.on("uncaughtException", listener);
  try {
    trigger();
    // 两轮宏任务：让 nextTick 里的 emit 完成
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("uncaughtException", listener);
  }
  return caught;
}

function readError(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -104 });
}

describe("drainChildProcessOutput", () => {
  it("排空让 stdout/stderr 进入流动模式（消费掉输出，避免管道写满）", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    expect(stdout.readableFlowing).toBeNull();
    expect(stderr.readableFlowing).toBeNull();

    drainChildProcessOutput({ stdout, stderr });

    expect(stdout.readableFlowing).toBe(true);
    expect(stderr.readableFlowing).toBe(true);
  });

  it("流错误按排空结束处理：不再逃逸为 uncaughtException", async () => {
    const stdout = new PassThrough();
    drainChildProcessOutput({ stdout, stderr: null });

    const caught = await catchUncaught(() => {
      // 走真实内核读错误路径：errorOrDestroy → destroy(err) → 异步 emit('error')
      process.nextTick(() => stdout.destroy(readError()));
    });

    expect(caught).toHaveLength(0);
    // 流已被错误终止（排空结束），不会再有可读内容
    expect(stdout.destroyed).toBe(true);
  });

  it("负向对照：未排空的流遇到同样的读错误会逃逸（修复所消除的缺口）", async () => {
    const bare = new PassThrough();

    const caught = await catchUncaught(() => {
      process.nextTick(() => bare.destroy(readError()));
    });

    expect(caught).toHaveLength(1);
    expect((caught[0] as { code?: string }).code).toBe("ECONNRESET");
  });
});

describe("tolerateChannelPeerDeath", () => {
  it("通道对端死亡引发的错误不再逃逸为 uncaughtException", async () => {
    const channel = new PassThrough();
    tolerateChannelPeerDeath(channel);

    const caught = await catchUncaught(() => {
      // 走真实内核读错误路径：errorOrDestroy → destroy(err) → 异步 emit('error')
      process.nextTick(() => channel.destroy(readError()));
    });

    expect(caught).toHaveLength(0);
    expect(channel.destroyed).toBe(true);
  });

  it("负向对照：没有容忍的通道遇到同样的错误会逃逸（修复所消除的缺口）", async () => {
    const bare = new PassThrough();

    const caught = await catchUncaught(() => {
      process.nextTick(() => bare.destroy(readError()));
    });

    expect(caught).toHaveLength(1);
    expect((caught[0] as { code?: string }).code).toBe("ECONNRESET");
  });

  it("容忍是幂等的，且不吞掉通道自身的可用性（可正常写入）", () => {
    const channel = new PassThrough();
    tolerateChannelPeerDeath(channel);
    tolerateChannelPeerDeath(channel);

    expect(channel.listenerCount("error")).toBe(2);
    expect(channel.write("GO token\n")).toBe(true);
  });
});
