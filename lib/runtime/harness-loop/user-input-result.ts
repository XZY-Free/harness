import type { CapabilityCatalogSnapshot } from "./capability-catalog";
import type { HarnessActionExecutors } from "./loop";
import type { RequestUserInputAction } from "./types";

export function createUserInputResult(
  action: RequestUserInputAction,
  catalog: CapabilityCatalogSnapshot,
): Awaited<ReturnType<NonNullable<HarnessActionExecutors["request_user_input"]>>> {
  const needsTrustedIdentity = catalog.agents.some((agent) =>
    agent.contextRequirements.some((key) => /enterprise_user_context|employee_identity/.test(key)),
  );
  const schema = action.payload.inputSchema;
  const properties = schema.properties;
  const identityPattern =
    /employee[_\s-]?(?:id|no|number)|staff[_\s-]?(?:id|no|number)|员工(?:编号|号|ID)|工号|企业身份|访问令牌|密码/i;
  const fields =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties)
      : [];
  const identityRequested =
    needsTrustedIdentity &&
    (identityPattern.test(action.payload.prompt) ||
      fields.some(([key, value]) => identityPattern.test(`${key} ${JSON.stringify(value)}`)));
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
  if (identityRequested || !usable) {
    return {
      authorityRef: `harness-action:${action.actionId}`,
      observation: {
        observationType: "user_input",
        sourceRefs: [],
        summary: identityRequested
          ? "此输入请求未展示：员工身份由宿主可信上下文提供，禁止要求用户填写员工号、密码或令牌。未查到业务数据不表示身份缺失。请根据已有服务结果如实回复，不要再次索取身份信息。"
          : "此输入请求未展示：输入表单定义不受支持。请改为具有非空 properties 的 object，字段使用 string、number、integer 或 boolean。",
        data: {
          errorCode: identityRequested
            ? "TRUSTED_IDENTITY_INPUT_FORBIDDEN"
            : "USER_INPUT_SCHEMA_UNSUPPORTED",
        },
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
