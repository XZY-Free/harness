import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V4 Phase B-1：thread-runner 运行管理器单测。
 *
 * 验证核心生命周期：enqueue 立即返回 runId、subscribe 历史回放、cancel abort+flush、
 * reaper 超时回收。streamText/createUIMessageStream/finalizeThreadRun 用 mock 替换，
 * 聚焦 runner 自身的状态机与多播逻辑，不验证 LLM 调用。
 */

const mocks = vi.hoisted(() => ({
  appendThreadEvent: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  upsertMessageParts: vi.fn().mockResolvedValue(undefined),
  updateThreadPreviewUrl: vi.fn().mockResolvedValue(undefined),
  updateThreadStatus: vi.fn().mockResolvedValue(undefined),
  incrementThreadTokens: vi.fn().mockResolvedValue(undefined),
  failRunningToolRunsForThread: vi.fn().mockResolvedValue(undefined),
  // V7 S1-4：ThreadRun 终态写回 mock
  completeThreadRun: vi.fn().mockResolvedValue(undefined),
  failThreadRun: vi.fn().mockResolvedValue(undefined),
  cancelThreadRun: vi.fn().mockResolvedValue(undefined),
  heartbeatThreadRun: vi.fn().mockResolvedValue(undefined),
  // V7 S5-2：RunTranscriptChunk 持久化 mock
  appendRunTranscriptChunk: vi.fn().mockResolvedValue(undefined),
  finalizeThreadRun: vi.fn().mockResolvedValue({ previewUrl: "", status: "idle" }),
  // mock streamText：返回一个 toUIMessageStream，产出一个 data-artifact chunk 后结束
  streamText: vi.fn(),
  // 04-G9：mock stopAllSubagents，断言 cancelRun + onError 路径都调用它
  stopAllSubagents: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/db/queries", () => ({
  appendThreadEvent: mocks.appendThreadEvent,
  saveMessages: mocks.saveMessages,
  upsertMessageParts: mocks.upsertMessageParts,
  updateThreadPreviewUrl: mocks.updateThreadPreviewUrl,
  incrementThreadTokens: mocks.incrementThreadTokens,
  updateThreadStatus: mocks.updateThreadStatus,
  failRunningToolRunsForThread: mocks.failRunningToolRunsForThread,
  // P1-13: CAS 用的活跃态枚举
  ACTIVE_THREAD_STATUSES: [
    "executing",
    "planning",
    "awaiting_input",
    "awaiting_approval",
    "verifying",
    "delivering",
  ],
  // V7 S1-4：ThreadRun 终态写回
  completeThreadRun: mocks.completeThreadRun,
  failThreadRun: mocks.failThreadRun,
  cancelThreadRun: mocks.cancelThreadRun,
  heartbeatThreadRun: mocks.heartbeatThreadRun,
  // V7 S5-2：RunTranscriptChunk 持久化
  appendRunTranscriptChunk: mocks.appendRunTranscriptChunk,
  getThreadById: vi.fn().mockResolvedValue(null), // S1（07-P1-1）：无 projectId
}));

vi.mock("@/lib/ai/tool-runtime", () => ({
  executeToolRun: vi.fn(),
  setThreadProjectScope: vi.fn(),
  clearThreadProjectScope: vi.fn(),
  clearThreadSkillScope: vi.fn(),
  setThreadRunScope: vi.fn(),
  clearThreadRunScope: vi.fn(),
}));

vi.mock("@/lib/ai/preview-gate", () => ({
  finalizeThreadRun: mocks.finalizeThreadRun,
}));

// 04-G9：mock subagent registry 的 stopAllSubagents，验证取消链路调用
vi.mock("@/lib/subagent/registry", () => ({
  stopAllSubagents: mocks.stopAllSubagents,
}));

vi.mock("ai", () => ({
  createUIMessageStream: vi.fn(({ execute, onFinish, generateId }) => {
    // 模拟 createUIMessageStream：执行 execute（内部 writer.merge），收尾调 onFinish
    const chunks: unknown[] = [];
    const writer = {
      merge(s: { getReader: () => { read: () => Promise<{ done: boolean; value?: unknown }> } }) {
        // driveRun 会自己 reader.read，这里不重复消费
      },
      write(c: unknown) {
        chunks.push(c);
      },
    };
    void execute({ writer });
    return new ReadableStream<unknown>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
  }),
  streamText: mocks.streamText,
  stepCountIs: vi.fn(() => () => false),
}));

import {
  cancelRun,
  enqueue,
  getActiveRunForThread,
  getRunStatus,
  resolveMaxRunMs,
  resolveProviderOptions,
  resolveReasoningEffort,
  startReaper,
  stopReaper,
  subscribe,
} from "@/lib/runtime/thread-runner";
import { createUIMessageStream as mockedCreateUIMessageStream } from "ai";

const fakeChatModel = (id: string) => ({ id });

beforeEach(() => {
  vi.clearAllMocks();
  // 默认 streamText：产出 1 个 text chunk 后 onFinish（不调，由 createUIMessageStream mock 控制）
  mocks.streamText.mockImplementation(() => ({
    toUIMessageStream: () =>
      new ReadableStream({
        start(ctl) {
          ctl.close();
        },
      }),
  }));
});

afterEach(() => {
  stopReaper();
  vi.useRealTimers(); // B-2 reaper 测试用 fake timers，确保不泄漏到后续测试
  vi.unstubAllEnvs(); // B-2 env 测试用 vi.stubEnv，确保不泄漏到后续测试
});

describe("thread-runner 生命周期", () => {
  it("enqueue 立即返回 runId，run 进入 running", () => {
    const runId = enqueue({
      threadId: "t1",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
  });

  it("GLM-5 默认使用 minimal reasoning，并传给 provider", async () => {
    enqueue({
      threadId: "t-glm-reasoning",
      modelMessages: [],
      system: "sys",
      modelId: "glm-5.2",
      tools: {},
      getChatModel: fakeChatModel,
    });
    await vi.waitFor(() => expect(mocks.streamText).toHaveBeenCalled());
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 16_384,
        providerOptions: {
          openaiCompatible: { reasoningEffort: "minimal" },
          snowLlm: { clear_thinking: true },
        },
      }),
    );
  });

  // V7 S1-3：enqueue 接收预创建的 runId，不再自行生成
  it("enqueue 传入 runId → 返回相同 id（DB 事实源优先）", () => {
    const preRunId = "pre-created-run-id";
    const runId = enqueue({
      runId: preRunId,
      threadId: "t1-pre",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    expect(runId).toBe(preRunId);
    expect(getRunStatus(preRunId)).toBe("running");
  });

  it("subscribe 返回 ReadableStream（run 存在时）", () => {
    const runId = enqueue({
      threadId: "t2",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    const stream = subscribe(runId);
    expect(stream).not.toBeNull();
    // 流可读（即使立即结束也是合法 ReadableStream）
    expect(typeof stream?.getReader).toBe("function");
  });

  it("subscribe 不存在的 runId → 返回 null（SSE 端点据此返回明确终态）", async () => {
    const stream = subscribe("nonexistent-run");
    expect(stream).toBeNull();
  });

  it("cancelRun 把 running run 标 cancelled，落 status_changed 事件 + flush saveMessages", async () => {
    const runId = enqueue({
      threadId: "t3",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    await cancelRun(runId, "user_cancelled");
    // 审计事件：from executing → cancelled
    expect(mocks.appendThreadEvent).toHaveBeenCalledWith(
      "t3",
      "agent.status_changed",
      expect.objectContaining({ from: "executing", to: "cancelled", reason: "user_cancelled" }),
      runId,
    );
    // 状态落库
    expect(mocks.updateThreadStatus).toHaveBeenCalledWith("t3", "cancelled", expect.any(Array));
    // run 已不在活跃表
    expect(getRunStatus(runId)).toBeNull();
    // 04-G9：cancelRun 调用 stopAllSubagents(threadId)，取消该 thread 活跃子代理
    expect(mocks.stopAllSubagents).toHaveBeenCalledWith("t3");
    // V7 S1-4：cancelRun 写回 ThreadRun cancelled 终态
    expect(mocks.cancelThreadRun).toHaveBeenCalledWith(runId, "user_cancelled");
  });

  // 04-G9：cancelRun 不存在的 runId → 不调 stopAllSubagents（无 thread 可取消）
  it("cancelRun 不存在的 runId → 不调 stopAllSubagents", async () => {
    await cancelRun("nope");
    expect(mocks.stopAllSubagents).not.toHaveBeenCalled();
  });

  // 04-G9：onError 路径调用 stopAllSubagents（streamText 失败时取消活跃子代理）
  it("streamText onError 触发 → 调用 stopAllSubagents(threadId)（防 orphan 子代理跑到超时）", async () => {
    let capturedOnError: ((evt: { error: unknown }) => void) | undefined;
    mocks.streamText.mockImplementationOnce(
      (opts: { onError?: (evt: { error: unknown }) => void }) => {
        capturedOnError = opts?.onError;
        return {
          toUIMessageStream: () =>
            new ReadableStream({
              start(ctl) {
                ctl.close();
              },
            }),
        };
      },
    );
    enqueue({
      threadId: "t-onerror",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    await vi.waitFor(() => expect(capturedOnError).toBeDefined());
    capturedOnError?.({ error: new Error("provider 503") });
    // onError 触发 stopAllSubagents(threadId) best-effort 取消子代理
    await vi.waitFor(() => expect(mocks.stopAllSubagents).toHaveBeenCalledWith("t-onerror"));
    // P1-9: onError 也调 markFailed 落终态(failThreadRun),防 thread 卡 executing。
    // (markFailed 的 running 守卫在此 mock 场景下被 onFinish 先行置 done 跳过,
    //  真实 provider error 路径由 "流异常→markFailed" 用例覆盖)
  });

  it("cancelRun 不存在的 runId → 安全无操作（不抛错）", async () => {
    await expect(cancelRun("nope")).resolves.toBeUndefined();
  });

  it("getActiveRunForThread 返回活跃 run，cancel 后返回 null", async () => {
    const runId = enqueue({
      threadId: "t4",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    expect(getActiveRunForThread("t4")).toMatchObject({ runId, status: "running" });
    await cancelRun(runId);
    expect(getActiveRunForThread("t4")).toBeNull();
  });

  it("B-3: onFinish 已 upsert 落库(saveStarted)后 cancelRun 不双写", async () => {
    // 模拟 AI SDK v6 行为：abort 时 createUIMessageStream 仍经 flush 调 onFinish，
    // 带上已累积的 partial 消息并 upsert 落库。cancelRun await completion 后据 saveStarted 跳过兜底 flush。
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute, onFinish }: any) => {
      const writer = { merge() {}, write() {} };
      void execute({ writer });
      // 同步触发 onFinish：设置 finalMessages + saveStarted + upsertMessageParts（与真实 flush 时序等价）
      void onFinish?.({
        messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "partial" }] }],
      });
      return new ReadableStream({
        start(ctl: ReadableStreamDefaultController) {
          ctl.close();
        },
      });
    });
    const runId = enqueue({
      threadId: "t5",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    // 等待 driveRun 的 onFinish upsert 落库完成
    await vi.waitFor(() => expect(mocks.upsertMessageParts).toHaveBeenCalledTimes(1));
    // run 此时仍 running（reader 循环未结束前 cancel）
    await cancelRun(runId, "user_cancelled");
    // 关键：cancelRun 不再兜底 saveMessages（saveStarted 守卫防双写）
    expect(mocks.saveMessages).not.toHaveBeenCalled();
    expect(getRunStatus(runId)).toBeNull();
  });

  it("E-7: streamText onFinish 用 totalUsage 累加 thread token + 落审计事件", async () => {
    let capturedOnFinish: ((evt: { totalUsage?: unknown }) => Promise<void>) | undefined;
    mocks.streamText.mockImplementationOnce(
      (opts: { onFinish?: (evt: { totalUsage?: unknown }) => Promise<void> }) => {
        capturedOnFinish = opts?.onFinish;
        return {
          toUIMessageStream: () =>
            new ReadableStream({
              start(ctl) {
                ctl.close();
              },
            }),
        };
      },
    );
    enqueue({
      threadId: "t-usage",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    await vi.waitFor(() => expect(capturedOnFinish).toBeDefined());
    await capturedOnFinish?.({
      totalUsage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    });
    // E-7: 累加 Thread 冗余列（totalUsage 跨 step 累加，非最后一步 usage）
    expect(mocks.incrementThreadTokens).toHaveBeenCalledWith("t-usage", {
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
    });
    // 审计事件同步落库
    expect(mocks.appendThreadEvent).toHaveBeenCalledWith(
      "t-usage",
      "agent.usage",
      expect.objectContaining({ promptTokens: 120, completionTokens: 80, totalTokens: 200 }),
      expect.any(String),
    );
  });

  it("B-2: reaper 回收超时 running run → cancelRun 标 failed + 落 reaper_timeout 事件", async () => {
    vi.useFakeTimers();
    // 捕获 streamText 收到的 abortSignal，让 createUIMessageStream 的 pending 流在 abort 时关闭，
    // 否则 driveRun reader.read() 永久 pending，cancelRun 靠 2s 超时兜底且 driveRun 悬挂。
    let capturedSignal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts?.abortSignal;
      return { toUIMessageStream: () => new ReadableStream({ start() {} }) };
    });
    // createUIMessageStream 返回 pending 流（不 close）保持 run running；abort 时 close 让 driveRun 退出
    vi.mocked(mockedCreateUIMessageStream).mockImplementation(({ execute }: any) => {
      const writer = { merge() {}, write() {} };
      void execute({ writer });
      return new ReadableStream({
        start(controller) {
          capturedSignal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // 已关闭
            }
          });
        },
      });
    });
    startReaper(1000); // 1s 超时（测试用，避免等 5min）
    const runId = enqueue({
      threadId: "t-reap",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    expect(getRunStatus(runId)).toBe("running");
    // 推进 30s 触发 reaper interval（REAPER_INTERVAL_MS=30s），run 已超 1s → 调 cancelRun
    await vi.advanceTimersByTimeAsync(30_000);
    // cancelRun abort → 流 close → completion resolve（无需等 2s 超时）；刷微任务让 cancelRun 结算
    // cancelRun 内含 finalizePromise 竞态（driveRun finally 调 finalizeResolve 作安全网），
    // 推进 300ms 足够让异步链结算。
    await vi.advanceTimersByTimeAsync(300);
    // reaper 超时属于执行失败，不伪装成用户主动取消
    expect(mocks.updateThreadStatus).toHaveBeenCalledWith("t-reap", "failed", expect.any(Array));
    expect(mocks.appendThreadEvent).toHaveBeenCalledWith(
      "t-reap",
      "agent.status_changed",
      expect.objectContaining({ from: "executing", to: "failed", reason: "reaper_timeout" }),
      runId,
    );
    expect(mocks.failThreadRun).toHaveBeenCalledWith(runId, "reaper_timeout");
    expect(mocks.cancelThreadRun).not.toHaveBeenCalledWith(runId, "reaper_timeout");
    expect(mocks.appendRunTranscriptChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        payload: expect.objectContaining({ type: "error" }),
      }),
    );
    expect(getRunStatus(runId)).toBeNull();
    stopReaper();
    vi.useRealTimers();
  });

  it("B-3: onStepFinish 每个 step 边界 upsert parts，中断时已产出 part 已落库", async () => {
    // 模拟多步 run：step1 产出 partial text，step2 追加 tool part，最后 onFinish 收尾。
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(
      ({ execute, onStepFinish, onFinish }: any) => {
        const writer = { merge() {}, write() {} };
        void execute({ writer });
        const msgId = "msg-b3";
        // step1：text part
        void onStepFinish?.({
          responseMessage: {
            id: msgId,
            role: "assistant",
            parts: [{ type: "text", text: "partial-1" }],
          },
        });
        // step2：text + tool part（同 id 续写，parts 增长）
        void onStepFinish?.({
          responseMessage: {
            id: msgId,
            role: "assistant",
            parts: [
              { type: "text", text: "partial-1" },
              { type: "tool-call", toolCallId: "tc1" },
            ],
          },
        });
        // 收尾 onFinish（最终态 + trailing partial）
        void onFinish?.({
          messages: [{ id: msgId, role: "assistant", parts: [{ type: "text", text: "final" }] }],
        });
        return new ReadableStream({
          start(ctl: ReadableStreamDefaultController) {
            ctl.close();
          },
        });
      },
    );
    enqueue({
      threadId: "t-b3",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    // 等待 onStepFinish × 2 + onFinish × 1 三次 upsert 落库
    await vi.waitFor(() => expect(mocks.upsertMessageParts).toHaveBeenCalledTimes(3));
    // step1：仅 text part
    expect(mocks.upsertMessageParts).toHaveBeenCalledWith([
      expect.objectContaining({ id: "msg-b3", parts: [{ type: "text", text: "partial-1" }] }),
    ]);
    // step2：parts 增长（text + tool）
    expect(mocks.upsertMessageParts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "msg-b3",
        parts: [
          { type: "text", text: "partial-1" },
          { type: "tool-call", toolCallId: "tc1" },
        ],
      }),
    ]);
    // onFinish 收尾 upsert（最终态），不丢 partial
    expect(mocks.upsertMessageParts).toHaveBeenCalledWith([
      expect.objectContaining({ id: "msg-b3", parts: [{ type: "text", text: "final" }] }),
    ]);
  });
});

describe("B-2 reaper 超时阈值 env 配置 (resolveMaxRunMs)", () => {
  // V4 收尾：方案要求 THREAD_RUN_MAX_MS 可配，原硬编码 DEFAULT_MAX_RUN_MS 违反「默认值不写死」规范。
  it("THREAD_RUN_MAX_MS 合法正整数 → 用 env 值（ms）", () => {
    vi.stubEnv("THREAD_RUN_MAX_MS", "120000");
    expect(resolveMaxRunMs()).toBe(120_000);
  });

  it("缺省（空串）→ DEFAULT_MAX_RUN_MS（5min）", () => {
    vi.stubEnv("THREAD_RUN_MAX_MS", "");
    expect(resolveMaxRunMs()).toBe(5 * 60_000);
  });

  it("未设 env → DEFAULT_MAX_RUN_MS", () => {
    vi.unstubAllEnvs();
    expect(resolveMaxRunMs()).toBe(5 * 60_000);
  });

  it("非法值（0/负/NaN/纯空白）→ 回落 DEFAULT_MAX_RUN_MS", () => {
    for (const v of ["0", "-1", "abc", "  "]) {
      vi.stubEnv("THREAD_RUN_MAX_MS", v);
      expect(resolveMaxRunMs()).toBe(5 * 60_000);
    }
  });
});

describe("模型 reasoning effort", () => {
  it("GLM-5 系列默认 minimal，其他模型默认不传", () => {
    expect(resolveReasoningEffort("glm-5.2")).toBe("minimal");
    expect(resolveReasoningEffort("glm-5")).toBe("minimal");
    expect(resolveReasoningEffort("qwen-plus")).toBeUndefined();
  });

  it("SNOW_REASONING_EFFORT 显式配置优先", () => {
    vi.stubEnv("SNOW_REASONING_EFFORT", "low");
    expect(resolveReasoningEffort("glm-5.2")).toBe("low");
    expect(resolveReasoningEffort("qwen-plus")).toBe("low");
  });

  it("GLM 清除历史 reasoning，其他模型不发送 GLM 私有参数", () => {
    expect(resolveProviderOptions("glm-5.2")).toMatchObject({
      snowLlm: { clear_thinking: true },
    });
    expect(resolveProviderOptions("qwen-plus")).not.toHaveProperty("snowLlm");
  });
});

describe("V7 S1-4: ThreadRun 终态写回", () => {
  it("正常完成 → completeThreadRun 写回 completed + token 用量", async () => {
    let capturedStreamTextOnFinish: ((evt: { totalUsage?: unknown }) => Promise<void>) | undefined;
    mocks.streamText.mockImplementationOnce(
      (opts: { onFinish?: (evt: { totalUsage?: unknown }) => Promise<void> }) => {
        capturedStreamTextOnFinish = opts?.onFinish;
        return {
          toUIMessageStream: () =>
            new ReadableStream({
              start(ctl) {
                ctl.close();
              },
            }),
        };
      },
    );
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute }: any) => {
      const writer = { merge() {}, write() {} };
      void execute({ writer });
      // execute 调用 streamText 后，capturedStreamTextOnFinish 已捕获
      // 同步触发 streamText onFinish 设置 run.totalUsage
      void capturedStreamTextOnFinish?.({
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    const runId = enqueue({
      threadId: "t-s14-done",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    // driveRun finally → markDone → completeThreadRun
    await vi.waitFor(() => expect(mocks.completeThreadRun).toHaveBeenCalled());
    expect(mocks.completeThreadRun).toHaveBeenCalledWith(runId, {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it("正常完成但无 totalUsage → completeThreadRun 写回零 token", async () => {
    let capturedStreamTextOnFinish: ((evt: { totalUsage?: unknown }) => Promise<void>) | undefined;
    mocks.streamText.mockImplementationOnce(
      (opts: { onFinish?: (evt: { totalUsage?: unknown }) => Promise<void> }) => {
        capturedStreamTextOnFinish = opts?.onFinish;
        return {
          toUIMessageStream: () =>
            new ReadableStream({
              start(ctl) {
                ctl.close();
              },
            }),
        };
      },
    );
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute }: any) => {
      const writer = { merge() {}, write() {} };
      void execute({ writer });
      // onFinish 不传 totalUsage（provider 边缘行为）
      void capturedStreamTextOnFinish?.({});
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    const runId = enqueue({
      threadId: "t-s14-no-usage",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    await vi.waitFor(() => expect(mocks.completeThreadRun).toHaveBeenCalled());
    expect(mocks.completeThreadRun).toHaveBeenCalledWith(runId, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("流异常 → markFailed → failThreadRun 写回 failed + error", async () => {
    // createUIMessageStream 返回一个立即 error 的流，driveRun reader.read() 抛错 → markFailed
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute }: any) => {
      const writer = { merge() {}, write() {} };
      void execute({ writer });
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("provider crash"));
        },
      });
    });
    const runId = enqueue({
      threadId: "t-s14-fail",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    // driveRun .catch → markFailed → failThreadRun
    await vi.waitFor(() => expect(mocks.failThreadRun).toHaveBeenCalled());
    expect(mocks.failThreadRun).toHaveBeenCalledWith(runId, "provider crash");
  });
});

describe("V7 S5-2: RunTranscriptChunk 持久化", () => {
  it("running run 周期性刷新 ThreadRun 心跳", async () => {
    vi.useFakeTimers();
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute }: any) => {
      const writer = {
        merge() {},
        write() {},
      };
      void execute({ writer });
      return new ReadableStream({
        start(controller) {
          setTimeout(() => controller.close(), 31_000);
        },
      });
    });
    const runId = enqueue({
      threadId: "t-heartbeat",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.heartbeatThreadRun).toHaveBeenCalledWith(runId);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(mocks.completeThreadRun).toHaveBeenCalledWith(runId, expect.anything()),
    );
  });

  it("publish 产出的 UIMessageChunk 被 appendRunTranscriptChunk 落库", async () => {
    const textChunk = { type: "text-delta" as const, delta: "hello", id: "chunk-1" };
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute }: any) => {
      const writer = {
        merge() {},
        write(c: unknown) {},
      };
      void execute({ writer });
      return new ReadableStream({
        start(controller) {
          controller.enqueue(textChunk);
          controller.close();
        },
      });
    });
    const runId = enqueue({
      threadId: "t-s52-chunk",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    // driveRun reader 读取到 chunk 后 broadcaster.publish 分发，触发 appendRunTranscriptChunk
    await vi.waitFor(() => expect(mocks.appendRunTranscriptChunk).toHaveBeenCalled());
    expect(mocks.appendRunTranscriptChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t-s52-chunk",
        runId,
        kind: "ui_message_chunk",
        payload: textChunk,
      }),
    );
  });

  it("appendRunTranscriptChunk 失败不阻断 run 正常完成", async () => {
    mocks.appendRunTranscriptChunk.mockRejectedValueOnce(new Error("DB timeout"));
    const textChunk = { type: "text-delta" as const, delta: "world", id: "chunk-2" };
    vi.mocked(mockedCreateUIMessageStream).mockImplementationOnce(({ execute }: any) => {
      const writer = {
        merge() {},
        write(c: unknown) {},
      };
      void execute({ writer });
      return new ReadableStream({
        start(controller) {
          controller.enqueue(textChunk);
          controller.close();
        },
      });
    });
    const runId = enqueue({
      threadId: "t-s52-fail-open",
      modelMessages: [],
      system: "sys",
      modelId: "m1",
      tools: {},
      getChatModel: fakeChatModel,
    });
    // chunk 持久化失败不应阻塞 run 完成
    await vi.waitFor(() => expect(mocks.completeThreadRun).toHaveBeenCalled());
    expect(mocks.completeThreadRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    );
  });
});
