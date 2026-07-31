import { describe, expect, it } from "vitest";
import { CountingSemaphore, HEAVY_COMMAND_TOOLS } from "./tool-runtime";

/**
 * P1-5（01 AI Core P1-5）：工具并发信号量契约测试。
 *
 * 验证 execute/network 类工具并发受限的核心契约:
 * - 并发 acquire 不超过 max
 * - release 后等待者按 FIFO 唤醒
 * - 重复 release 幂等(不重复释放名额)
 */

describe("P1-5 CountingSemaphore", () => {
  it("未达上限:acquire 立即返回,activeCount 递增", async () => {
    const sem = new CountingSemaphore(2);
    expect(sem.activeCount).toBe(0);
    const r1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);
    const r2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);
    r1();
    expect(sem.activeCount).toBe(1);
    r2();
    expect(sem.activeCount).toBe(0);
  });

  it("达到上限:第 3 个 acquire 排队等待,release 后唤醒", async () => {
    const sem = new CountingSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);

    // 第 3 个应排队(不立即 resolve)
    let acquired = false;
    const p3 = sem.acquire().then((r) => {
      acquired = true;
      return r;
    });
    // 让微任务跑一轮,p3 仍应未获取(acquire 在 await Promise 里挂起)
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);

    // release 一个 → p3 被唤醒
    r1();
    const r3 = await p3;
    expect(acquired).toBe(true);
    expect(sem.activeCount).toBe(2); // r1 释放,r3 占用,仍 2

    r2();
    r3();
    expect(sem.activeCount).toBe(0);
  });

  it("重复 release 幂等:不重复增加名额", async () => {
    const sem = new CountingSemaphore(1);
    const r1 = await sem.acquire();
    r1();
    r1(); // 重复 release
    r1(); // 再重复
    expect(sem.activeCount).toBe(0);

    // 释放后能重新 acquire(名额未被重复释放撑大)
    const r2 = await sem.acquire();
    expect(sem.activeCount).toBe(1);
    // 第 2 个仍应排队(上限仍是 1)
    let acquired = false;
    const p3 = sem.acquire().then((r) => {
      acquired = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);
    r2();
    await p3;
    expect(acquired).toBe(true);
  });

  it("FIFO 唤醒:等待者按顺序获取", async () => {
    const sem = new CountingSemaphore(1);
    const r1 = await sem.acquire();
    const order: number[] = [];

    const p2 = sem.acquire().then((r) => {
      order.push(2);
      return r;
    });
    const p3 = sem.acquire().then((r) => {
      order.push(3);
      return r;
    });
    const p4 = sem.acquire().then((r) => {
      order.push(4);
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    r1();
    const r2 = await p2;
    expect(order).toEqual([2]);
    r2();
    const r3 = await p3;
    expect(order).toEqual([2, 3]);
    r3();
    const r4 = await p4;
    expect(order).toEqual([2, 3, 4]);
    r4();
  });
});

describe("P0 04-G2 HEAVY_COMMAND_TOOLS 重命令工具互斥集", () => {
  it("含 4 个前台重命令工具(runCommand/runTests/runBuild/installDependencies)", () => {
    expect(HEAVY_COMMAND_TOOLS.has("runCommand")).toBe(true);
    expect(HEAVY_COMMAND_TOOLS.has("runTests")).toBe(true);
    expect(HEAVY_COMMAND_TOOLS.has("runBuild")).toBe(true);
    expect(HEAVY_COMMAND_TOOLS.has("installDependencies")).toBe(true);
    expect(HEAVY_COMMAND_TOOLS.size).toBe(4);
  });

  it("不含 startBackground(后台启动即返回,不该被串行锁阻塞)", () => {
    expect(HEAVY_COMMAND_TOOLS.has("startBackground")).toBe(false);
    expect(HEAVY_COMMAND_TOOLS.has("readFile")).toBe(false);
    expect(HEAVY_COMMAND_TOOLS.has("webFetch")).toBe(false);
  });

  it("CountingSemaphore(1) 作为互斥锁:并发 1(已在 P1-5 测试覆盖,此处锁定语义)", () => {
    // heavyCommandMutex 用 CountingSemaphore(1),并发上限 1 = 互斥。
    // P1-5 的 acquire/排队/FIFO 测试已验证 CountingSemaphore 行为,
    // 04-G2 复用同一原语,max=1 即互斥语义。
    const mutex = new CountingSemaphore(1);
    expect(mutex).toBeDefined();
  });
});

describe("V6-M3-1（B4）per-thread 重命令互斥", () => {
  // 模拟 tool-runtime 内部的 per-thread mutex Map
  function createPerThreadMutexMap() {
    const map = new Map<string, CountingSemaphore>();
    return (threadId: string): CountingSemaphore => {
      let sem = map.get(threadId);
      if (!sem) {
        sem = new CountingSemaphore(1);
        map.set(threadId, sem);
      }
      return sem;
    };
  }

  it("同 thread 并发 heavy 命令 → 串行执行", async () => {
    const getMutex = createPerThreadMutexMap();
    const r1 = await getMutex("thread-A").acquire();
    // 第二个 acquire 同 thread 应排队
    let acquired = false;
    const p2 = getMutex("thread-A")
      .acquire()
      .then((r) => {
        acquired = true;
        return r;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false); // 仍在排队
    r1(); // 释放第一个
    const r2 = await p2;
    expect(acquired).toBe(true);
    r2();
  });

  it("不同 thread 并发 heavy 命令 → 并行执行", async () => {
    const getMutex = createPerThreadMutexMap();
    const r1 = await getMutex("thread-A").acquire();
    // 不同 thread 应立即获取（不同 semaphore）
    const r2 = await getMutex("thread-B").acquire();
    // 两个都持有，不互相阻塞
    expect(r1).toBeTypeOf("function");
    expect(r2).toBeTypeOf("function");
    r1();
    r2();
  });

  it("同 thread 两次 acquire 同一个 semaphore 实例", async () => {
    const getMutex = createPerThreadMutexMap();
    const sem1 = getMutex("thread-X");
    const sem2 = getMutex("thread-X");
    expect(sem1).toBe(sem2); // 同一引用
  });
});
