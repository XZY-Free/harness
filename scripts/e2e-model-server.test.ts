import { describe, expect, it } from "vitest";
import { buildE2eModelReply } from "./e2e-model-response";

describe("e2e deterministic model Harness protocol", () => {
  it("行动决策请求返回合法的单步 respond JSON，而不是普通聊天正文", async () => {
    const content = buildE2eModelReply(
      '你是 SnowHarness 的行动决策器。每步只返回一个符合 Schema 的行动。\n\n{"objective":"你好"}',
    );

    expect(JSON.parse(content)).toEqual({
      actionId: "e2e-respond-1",
      stepNo: 1,
      purposeCode: "answer_user",
      shortPurpose: "生成最终回答",
      actionType: "respond",
      payload: {},
    });
  });
});
