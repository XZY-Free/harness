import type { HarnessActionExecutors } from "./loop";
import type { RequestUserInputAction } from "./types";

export function createUserInputResult(
  action: RequestUserInputAction,
): Awaited<ReturnType<NonNullable<HarnessActionExecutors["request_user_input"]>>> {
  const schema = action.payload.inputSchema;
  const properties = schema.properties;
  const fields =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties)
      : [];
  const usable =
    schema.type === "object" &&
    fields.length > 0 &&
    fields.every(
      ([, value]) =>
        value &&
        typeof value === "object" &&
        ["string", "number", "integer", "boolean"].includes(
          (value as { type?: string }).type ?? "string",
        ),
    );
  if (!usable) {
    return {
      authorityRef: `harness-action:${action.actionId}`,
      observation: {
        observationType: "user_input",
        sourceRefs: [],
        summary:
          "此输入请求未展示：输入表单定义不受支持。请改为具有非空 properties 的 object，字段使用 string、number、integer 或 boolean。",
        data: { errorCode: "USER_INPUT_SCHEMA_UNSUPPORTED" },
      },
    };
  }
  return {
    authorityRef: `harness-action:${action.actionId}`,
    observation: {
      observationType: "user_input",
      summary: "已请求用户补充信息",
      sourceRefs: [],
      data: { purpose: action.payload.purpose },
    },
    waitingForUser: {
      requestType: "input",
      purpose: action.payload.purpose,
      prompt: action.payload.prompt,
      inputSchema: action.payload.inputSchema,
    },
  };
}
