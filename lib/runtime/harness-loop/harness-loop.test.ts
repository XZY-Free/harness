import { describe, expect, it, vi } from "vitest";
import {
  type HarnessActionExecutors,
  type HarnessDecisionPort,
  type HarnessFinalResponsePort,
  HarnessLoop,
  type HarnessLoopEventWriter,
} from "./loop";
import type { RequestUserInputAction } from "./types";

function decisionPort(actions: unknown[], views: unknown[] = []): HarnessDecisionPort {
  let index = 0;
  return {
    async decideNextAction(view) {
      views.push(view);
      const action = actions[index];
      index += 1;
      return action;
    },
  };
}

function finalPort(text = "最终回答"): HarnessFinalResponsePort {
  return {
    async generateFinalResponse(_view, emitDelta) {
      await emitDelta?.(text);
      return text;
    },
  };
}

function eventWriter(): HarnessLoopEventWriter & {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    async write(type, payload) {
      events.push({ type, payload });
    },
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    invocationId: "inv-1",
    tenantId: "tenant-1",
    threadId: "thread-1",
    turnId: "turn-1",
    objective: "查询制度并回答",
    contextHandle: "ctx-1",
    capabilityDirectives: [],
    decisionPort: decisionPort([
      {
        actionId: "action-1",
        stepNo: 1,
        actionType: "respond",
        purposeCode: "answer_ready",
        shortPurpose: "已有足够信息",
        payload: { evidenceRefs: [] },
      },
    ]),
    finalResponsePort: finalPort(),
    eventWriter: eventWriter(),
    executors: {} satisfies HarnessActionExecutors,
    modelRef: "test-model",
    ...overrides,
  };
}

describe("HarnessLoop", () => {
  it("respond 先提交行动，再生成最终正文并完成 Invocation", async () => {
    const writer = eventWriter();
    const generateFinalResponse = vi.fn(finalPort("制度回答").generateFinalResponse);
    const loop = new HarnessLoop(
      baseParams({
        eventWriter: writer,
        finalResponsePort: { generateFinalResponse },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({ completed: true, responseText: "制度回答" });
    expect(writer.events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "response.completed",
      "harness.action.completed",
      "execution.completed",
    ]);
    expect(generateFinalResponse).toHaveBeenCalledOnce();
  });

  it("用户选择 Agent 但决策直接 respond 时不调用 Agent", async () => {
    const agent = vi.fn();
    const loop = new HarnessLoop(
      baseParams({
        capabilityDirectives: [
          { capability_type: "agent", capability_id: "agent-1", mode: "preferred" },
        ],
        executors: { "agent.call": agent },
      }),
    );

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(agent).not.toHaveBeenCalled();
  });

  it("knowledge.search observation 进入下一步决策与最终正文视图", async () => {
    const views: Array<any> = [];
    const knowledge = vi.fn(async () => ({
      observation: {
        observationType: "knowledge",
        summary: "年假制度为每年 10 天",
        sourceRefs: ["knowledge_document:doc-1:rev-2"],
        data: { status: "ok" },
      },
      authorityRef: "knowledge-result:action-1",
    }));
    const loop = new HarnessLoop(
      baseParams({
        decisionPort: decisionPort(
          [
            {
              actionId: "action-1",
              stepNo: 1,
              actionType: "knowledge.search",
              purposeCode: "load_policy",
              shortPurpose: "读取年假制度",
              payload: { query: "年假制度", maxResults: 5 },
            },
            {
              actionId: "action-2",
              stepNo: 2,
              actionType: "respond",
              purposeCode: "answer_ready",
              shortPurpose: "制度证据已取得",
              payload: { evidenceRefs: ["knowledge_document:doc-1:rev-2"] },
            },
          ],
          views,
        ),
        executors: { "knowledge.search": knowledge },
      }),
    );

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(knowledge).toHaveBeenCalledOnce();
    expect(views[1].observations).toEqual([
      expect.objectContaining({
        observationType: "knowledge",
        sourceRefs: ["knowledge_document:doc-1:rev-2"],
      }),
    ]);
  });

  it("committed action 缺少执行器时写 action.failed 并正式失败，不生成正文", async () => {
    const writer = eventWriter();
    const generateFinalResponse = vi.fn(finalPort().generateFinalResponse);
    const loop = new HarnessLoop(
      baseParams({
        eventWriter: writer,
        decisionPort: decisionPort([
          {
            actionId: "action-1",
            stepNo: 1,
            actionType: "knowledge.search",
            purposeCode: "load_policy",
            shortPurpose: "读取制度",
            payload: { query: "年假制度" },
          },
        ]),
        finalResponsePort: { generateFinalResponse },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({
      completed: false,
      errorCode: "HARNESS_ACTION_EXECUTOR_UNAVAILABLE",
    });
    expect(writer.events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.failed",
      "execution.failed",
    ]);
    expect(generateFinalResponse).not.toHaveBeenCalled();
  });

  it("knowledge executor 失败使用稳定错误码且不回到 respond", async () => {
    const writer = eventWriter();
    const generateFinalResponse = vi.fn(finalPort().generateFinalResponse);
    const loop = new HarnessLoop(
      baseParams({
        eventWriter: writer,
        decisionPort: decisionPort([
          {
            actionId: "action-1",
            stepNo: 1,
            actionType: "knowledge.search",
            purposeCode: "load_policy",
            shortPurpose: "读取制度",
            payload: { query: "年假制度" },
          },
        ]),
        executors: {
          "knowledge.search": async () => {
            throw new Error("索引不可用");
          },
        },
        finalResponsePort: { generateFinalResponse },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({ completed: false, errorCode: "KNOWLEDGE_ACTION_FAILED" });
    expect(writer.events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "harness.action.failed",
      "execution.failed",
    ]);
    expect(generateFinalResponse).not.toHaveBeenCalled();
  });

  it("request_user_input 形成正式用户操作事件并暂停同一 Invocation", async () => {
    const writer = eventWriter();
    const loop = new HarnessLoop(
      baseParams({
        eventWriter: writer,
        decisionPort: decisionPort([
          {
            actionId: "action-input-1",
            stepNo: 1,
            actionType: "request_user_input",
            purposeCode: "missing_employee_id",
            shortPurpose: "缺少员工编号",
            payload: {
              purpose: "missing_employee_id",
              prompt: "请提供员工编号",
              inputSchema: { type: "object", required: ["employee_id"] },
            },
          },
        ]),
        executors: {
          request_user_input: async (action: RequestUserInputAction) => ({
            authorityRef: "user-action:uar-1",
            observation: {
              observationType: "user_input",
              summary: "等待员工编号",
              sourceRefs: [],
              data: {},
            },
            waitingForUser: {
              requestType: "input",
              purpose: action.payload.purpose,
              prompt: action.payload.prompt,
              inputSchema: action.payload.inputSchema,
            },
          }),
        },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({ completed: false, waitingForUser: true });
    expect(writer.events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "user_action.requested",
      "harness.action.completed",
    ]);
  });

  it("agent.call 只能指向本 Turn preferred Agent", async () => {
    const agent = vi.fn();
    const writer = eventWriter();
    const loop = new HarnessLoop(
      baseParams({
        capabilityDirectives: [
          { capability_type: "agent", capability_id: "agent-allowed", mode: "preferred" },
        ],
        eventWriter: writer,
        decisionPort: decisionPort([
          {
            actionId: "action-1",
            stepNo: 1,
            actionType: "agent.call",
            purposeCode: "query_balance",
            shortPurpose: "查询本人年假余额",
            payload: { agentId: "agent-other", task: "查询员工年假余额" },
          },
        ]),
        executors: { "agent.call": agent },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({ completed: false, errorCode: "AGENT_ACTION_NOT_ALLOWED" });
    expect(agent).not.toHaveBeenCalled();
    expect(writer.events.some((event) => event.type === "harness.action.started")).toBe(false);
  });

  it("超过连续相同行动预算时失败且不执行第三次", async () => {
    const knowledge = vi.fn(async () => ({
      observation: {
        observationType: "knowledge" as const,
        summary: "无结果",
        sourceRefs: [],
        data: { status: "empty" },
      },
    }));
    const repeated = (actionId: string, stepNo: number) => ({
      actionId,
      stepNo,
      actionType: "knowledge.search",
      purposeCode: "load_policy",
      shortPurpose: "重复检索",
      payload: { query: "年假制度" },
    });
    const loop = new HarnessLoop(
      baseParams({
        decisionPort: decisionPort([
          repeated("action-1", 1),
          repeated("action-2", 2),
          repeated("action-3", 3),
        ]),
        executors: { "knowledge.search": knowledge },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({
      completed: false,
      errorCode: "HARNESS_LOOP_REPEATED_ACTION",
    });
    expect(knowledge).toHaveBeenCalledTimes(2);
  });

  it("超过最大步骤数时失败，不向决策模型请求额外 action", async () => {
    const decideNextAction = vi.fn(async ({ actionHistory }: any) => ({
      actionId: `action-${actionHistory.length + 1}`,
      stepNo: actionHistory.length + 1,
      actionType: "knowledge.search",
      purposeCode: "load_policy",
      shortPurpose: "继续检索",
      payload: { query: `年假制度-${actionHistory.length + 1}` },
    }));
    const loop = new HarnessLoop(
      baseParams({
        decisionPort: { decideNextAction },
        limits: { maxLoopSteps: 2 },
        executors: {
          "knowledge.search": async () => ({
            observation: {
              observationType: "knowledge",
              summary: "继续",
              sourceRefs: [],
              data: {},
            },
          }),
        },
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({
      completed: false,
      errorCode: "HARNESS_LOOP_STEP_LIMIT_EXCEEDED",
    });
    expect(decideNextAction).toHaveBeenCalledTimes(2);
  });

  it("严格拒绝 action payload 多余字段", async () => {
    const loop = new HarnessLoop(
      baseParams({
        decisionPort: decisionPort([
          {
            actionId: "action-1",
            stepNo: 1,
            actionType: "respond",
            purposeCode: "answer_ready",
            shortPurpose: "回答",
            payload: { evidenceRefs: [], endpoint: "https://forbidden.example" },
          },
        ]),
      }),
    );

    const result = await loop.run();

    expect(result).toMatchObject({
      completed: false,
      errorCode: "HARNESS_ACTION_SCHEMA_INVALID",
    });
  });

  it("从 completed action 恢复 observation，不重复执行既有副作用", async () => {
    const recoveredAction = {
      actionId: "action-1",
      stepNo: 1,
      actionType: "knowledge.search" as const,
      purposeCode: "load_policy",
      shortPurpose: "读取制度",
      payload: { query: "年假制度" },
    };
    const recoveredObservation = {
      observationType: "knowledge" as const,
      summary: "年假制度为每年 10 天",
      sourceRefs: ["knowledge_document:doc-1:rev-1"],
      data: { status: "ok" },
    };
    const knowledge = vi.fn();
    const views: Array<any> = [];
    const loop = new HarnessLoop(
      baseParams({
        recoveryPort: {
          async load() {
            return {
              invocationState: "running" as const,
              nextProducerSequence: 4,
              observations: [recoveredObservation],
              actionHistory: [
                {
                  ...recoveredAction,
                  action: recoveredAction,
                  actionDigest:
                    "sha256:2aca91513d78d49bd4866b6f1ba45b9bb3580880477c791a136cd431443dae15",
                  targetRef: null,
                  state: "completed" as const,
                  observation: recoveredObservation,
                },
              ],
            };
          },
        },
        decisionPort: decisionPort(
          [
            {
              actionId: "action-2",
              stepNo: 2,
              actionType: "respond",
              purposeCode: "answer_ready",
              shortPurpose: "恢复证据后回答",
              payload: { evidenceRefs: recoveredObservation.sourceRefs },
            },
          ],
          views,
        ),
        executors: { "knowledge.search": knowledge },
      }),
    );

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(knowledge).not.toHaveBeenCalled();
    expect(views[0].observations).toEqual([recoveredObservation]);
    expect(views[0].actionHistory).toHaveLength(1);
  });
});
