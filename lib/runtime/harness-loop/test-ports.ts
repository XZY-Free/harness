import type { HarnessDecisionPort, HarnessFinalResponsePort, HarnessLoopView } from "./loop";

/** 测试/Conformance 用确定性端口；不进入正式 Runtime 装配。 */
export function createDirectResponsePorts(
  response: (
    view: HarnessLoopView,
    emitDelta?: (delta: string) => Promise<void>,
  ) => string | Promise<string>,
): {
  decisionPort: HarnessDecisionPort;
  finalResponsePort: HarnessFinalResponsePort;
} {
  return {
    decisionPort: {
      async decideNextAction(view) {
        const stepNo = view.actionHistory.length + 1;
        return {
          actionId: `test-respond-${stepNo}`,
          stepNo,
          actionType: "respond",
          purposeCode: "test_response_ready",
          shortPurpose: "测试已准备直接回答",
          payload: { evidenceRefs: [] },
        };
      },
    },
    finalResponsePort: {
      async generateFinalResponse(view, emitDelta) {
        return response(view, emitDelta);
      },
    },
  };
}
