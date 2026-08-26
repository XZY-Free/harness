import {
  PublicAgentContractError,
  computePublicAgentContractDigest,
  parsePublicAgentContract,
} from "@/lib/agents/domain/public-agent-contract";
/**
 * Public Agent Contract 领域解析/规范化测试。
 *
 * 不变量：agent-contract.json 是 request-only 输入——解析结果只包含显式结构化事实
 * （identity/capabilities/contexts/interaction/result_contract），绝不保留原始合同对象、
 * 原始 JSON 或整节 payload；digest 稳定（对象键序无关、数组序即合同序）。
 *
 * 事实源：本切片冻结的 Public Agent Contract 目标模型。
 */
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import { describe, expect, it } from "vitest";

/** 深拷贝 fixture（避免 as const 只读类型阻碍注入非法字段）。 */
function contract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(hrAgentContract)) as Record<string, unknown>;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe("parsePublicAgentContract", () => {
  it("解析为显式结构化事实，不保留原始合同/整节 JSON", () => {
    const facts = parsePublicAgentContract(contract());

    // 身份事实为显式标量
    expect(facts.contractVersion).toBe("1.0.0");
    expect(facts.agent.id).toBe("hr-assistant");
    expect(facts.agent.version).toBe("1.0.0");
    expect(facts.agent.nameZhCn).toBe("企业人力智能助手");
    expect(facts.agent.nameEn).toBe("Enterprise HR Assistant");

    // interaction 六布尔显式保留（含 false；真实 artifact 目标值）
    expect(facts.interaction).toEqual({
      streamingTransport: true,
      incrementalContent: false,
      inputRequired: true,
      resume: true,
      cancel: false,
      durableTaskRecovery: false,
      supportedLocales: ["zh-CN"],
    });

    // capabilities / contexts 为有序结构化记录（真实 artifact 顺序）
    expect(facts.capabilities.map((c) => c.key)).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
      "hr-policy-and-benefits-consultation",
      "hr-system-and-document-assistance",
    ]);
    expect(facts.capabilities[0]!.nameZhCn).toBe("假勤与请假服务");
    expect(facts.capabilities[0]!.nameEn).toBe("Leave and Attendance Service");
    expect(facts.capabilities[0]!.descriptionZhCn).toContain("请假申请");
    expect(facts.capabilities[0]!.descriptionEn).toContain("Leave requests");
    // 当前 artifact 无 tags/examples/input_modes/output_modes —— 规范化为空数组，不虚构
    expect(facts.capabilities[0]!.tags).toEqual([]);
    expect(facts.capabilities[0]!.examples).toEqual([]);
    expect(facts.capabilities[0]!.inputModes).toEqual([]);
    expect(facts.capabilities[0]!.outputModes).toEqual([]);

    expect(facts.invocationContexts.map((c) => c.key)).toEqual([
      "execution_subject",
      "timezone",
      "current_datetime",
      "locale",
      "conversation_summary",
      "attachment_references",
    ]);
    expect(facts.invocationContexts.map((c) => c.necessity)).toEqual([
      "preferred",
      "preferred",
      "preferred",
      "preferred",
      "preferred",
      "accepted",
    ]);
    expect(facts.invocationContexts[0]!.nameZhCn).toBe("执行主体");
    expect(facts.invocationContexts[0]!.descriptionZhCn).toContain("可信调用者身份");
    expect(facts.invocationContexts[0]!.appliesTo).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
    ]);
    expect(facts.invocationContexts[5]!.appliesTo).toEqual(["hr-system-and-document-assistance"]);
    expect(facts.invocationContexts[1]!.appliesTo).toBeNull();
    // artifact wire 上无 trust_requirement / declaration_source —— 解析结果为 null（系统
    // provenance 是持久化层赋值，不是 wire 事实，解析器不得虚构）
    expect(facts.invocationContexts[0]!.trustRequirement).toBeNull();
    expect(facts.invocationContexts[0]!.declarationSource).toBeNull();

    // result_contract 为结构化数组，不是整节 JSON（真实 artifact 顺序）
    expect(facts.resultFields).toEqual([
      "request_id",
      "status",
      "answer",
      "result_type",
      "data",
      "actions",
      "error_code",
      "retryable",
      "agent_name",
      "agent_version",
    ]);
    expect(facts.errorCodes).toEqual([
      "identity_required",
      "identity_unverified",
      "input_required",
      "not_found",
      "rejected",
      "temporarily_unavailable",
      "failed",
      "cancelled",
      "contract_error",
    ]);
    expect(facts.resultNotesZhCn).toContain("answer为人类可读主回答");
    expect(facts.resultNotesEn).toBeNull();

    // 解析结果本身不携带原始合同：序列化后不得出现蛇形原文字段名
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("contract_version");
    expect(serialized).not.toContain("invocation_context");
    expect(serialized).not.toContain("result_contract");
  });

  it("可选英文/描述缺失规范化为 null（zh-CN 必需不可缺）", () => {
    const input = contract();
    for (const c of input.capabilities as Record<string, unknown>[]) {
      (c as { name: Record<string, unknown> }).name = {
        "zh-CN": (c as { name: { "zh-CN": string } }).name["zh-CN"],
      };
      (c as Record<string, unknown>).description = undefined;
    }
    const facts = parsePublicAgentContract(input);
    expect(facts.capabilities[0]!.nameEn).toBeNull();
    expect(facts.capabilities[0]!.descriptionZhCn).toBeNull();
    expect(facts.capabilities[0]!.descriptionEn).toBeNull();
  });

  it("02 §4 语义校验：incremental_content=true 要求 streaming_transport=true；组合合法时保留", () => {
    const incrementalOnly = contract();
    incrementalOnly.interaction = {
      ...(incrementalOnly.interaction as Record<string, unknown>),
      incremental_content: true,
    };
    expect(() => parsePublicAgentContract(incrementalOnly)).not.toThrow();
    expect(parsePublicAgentContract(incrementalOnly).interaction.incrementalContent).toBe(true);

    const nonStreamingIncremental = contract();
    nonStreamingIncremental.interaction = {
      ...(nonStreamingIncremental.interaction as Record<string, unknown>),
      streaming_transport: false,
      incremental_content: true,
    };
    expect(() => parsePublicAgentContract(nonStreamingIncremental)).toThrowError(
      /incremental_content=true 要求 streaming_transport=true/,
    );
  });

  it("digest 为 sha256:64hex；对象键序无关，数组序即合同序", () => {
    const a = parsePublicAgentContract(contract());
    // 键序重排（顶层与嵌套均反序）
    const reordered = contract();
    reordered.interaction = {
      supported_locales: ["zh-CN"],
      durable_task_recovery: false,
      cancel: false,
      resume: true,
      input_required: true,
      incremental_content: false,
      streaming_transport: true,
    };
    const b = parsePublicAgentContract(reordered);
    expect(a.contractDigest).toMatch(DIGEST_PATTERN);
    expect(a.capabilityDigest).toMatch(DIGEST_PATTERN);
    expect(a.contextDigest).toMatch(DIGEST_PATTERN);
    expect(b.contractDigest).toBe(a.contractDigest);
    expect(computePublicAgentContractDigest(b)).toBe(a.contractDigest);

    // 数组顺序变化 = 合同事实变化
    const swapped = contract();
    const caps = swapped.capabilities as unknown[];
    [caps[0], caps[1]] = [caps[1], caps[0]];
    const c = parsePublicAgentContract(swapped);
    expect(c.contractDigest).not.toBe(a.contractDigest);
    expect(c.capabilityDigest).not.toBe(a.capabilityDigest);

    // 任一外部有意义事实变化 → digest 变化
    const mutated = contract();
    ((mutated.interaction as Record<string, unknown>).durable_task_recovery as boolean) = true;
    expect(parsePublicAgentContract(mutated).contractDigest).not.toBe(a.contractDigest);
  });

  describe("fail-closed 校验（每个非法类别都拒绝）", () => {
    function expectReject(mutate: (input: Record<string, unknown>) => void) {
      const input = contract();
      mutate(input);
      expect(() => parsePublicAgentContract(input)).toThrow(PublicAgentContractError);
    }

    it("未知顶层键拒绝（含 secrets 类字段）", () => {
      expectReject((i) => {
        i.authorization = "Bearer xxx";
      });
      expectReject((i) => {
        i.agent_card_url = "https://provider.example/card.json";
      });
      expectReject((i) => {
        i.contract_url = "https://provider.example/contract.json";
      });
    });

    it("agent 内未知键（secrets）拒绝", () => {
      expectReject((i) => {
        (i.agent as Record<string, unknown>).client_secret = "s3cret";
      });
      expectReject((i) => {
        (i.agent as Record<string, unknown>).runtime_api_key = "k";
      });
    });

    it("context 内未知键（employee_id/corp_id 等私密字段）拒绝", () => {
      expectReject((i) => {
        (i.invocation_context as Record<string, unknown>[])[0]!.employee_id = "E001";
      });
      expectReject((i) => {
        (i.invocation_context as Record<string, unknown>[])[0]!.corp_id = "corp1";
      });
    });

    it("contract_version 缺失/null/空拒绝", () => {
      expectReject((i) => {
        i.contract_version = undefined;
      });
      expectReject((i) => {
        i.contract_version = null;
      });
      expectReject((i) => {
        i.contract_version = "";
      });
    });

    it("agent id/version/name zh-CN 缺失或空拒绝", () => {
      expectReject((i) => {
        (i.agent as Record<string, unknown>).id = undefined;
      });
      expectReject((i) => {
        (i.agent as Record<string, unknown>).id = "";
      });
      expectReject((i) => {
        (i.agent as Record<string, unknown>).version = undefined;
      });
      expectReject((i) => {
        (i.agent as Record<string, unknown>).name = { en: "HR Assistant" };
      });
    });

    it("capabilities 为空数组拒绝；capability key 重复拒绝", () => {
      expectReject((i) => {
        i.capabilities = [];
      });
      expectReject((i) => {
        const caps = i.capabilities as Record<string, unknown>[];
        caps[1]!.key = caps[0]!.key;
      });
    });

    it("capability 携带 Tool/RPC/函数式字段拒绝", () => {
      expectReject((i) => {
        (i.capabilities as Record<string, unknown>[])[0]!.parameters = {
          type: "object",
          properties: {},
        };
      });
      expectReject((i) => {
        (i.capabilities as Record<string, unknown>[])[0]!.function = { name: "leave_query" };
      });
      expectReject((i) => {
        (i.capabilities as Record<string, unknown>[])[0]!.rpc_method = "LeaveService.Query";
      });
    });

    it("context key 重复/非法、necessity 非法拒绝", () => {
      expectReject((i) => {
        const ctxs = i.invocation_context as Record<string, unknown>[];
        ctxs[1]!.key = ctxs[0]!.key;
      });
      expectReject((i) => {
        (i.invocation_context as Record<string, unknown>[])[0]!.key = "";
      });
      expectReject((i) => {
        (i.invocation_context as Record<string, unknown>[])[0]!.necessity = "mandatory";
      });
      expectReject((i) => {
        (i.invocation_context as Record<string, unknown>[])[0]!.necessity = null;
      });
    });

    it("interaction 任一布尔缺失/null/非布尔拒绝（显式 false 合法）", () => {
      for (const flag of [
        "streaming_transport",
        "incremental_content",
        "input_required",
        "resume",
        "cancel",
        "durable_task_recovery",
      ]) {
        expectReject((i) => {
          (i.interaction as Record<string, unknown>)[flag] = undefined;
        });
        expectReject((i) => {
          (i.interaction as Record<string, unknown>)[flag] = null;
        });
        expectReject((i) => {
          (i.interaction as Record<string, unknown>)[flag] = "true";
        });
      }
      // HR 现行 artifact 恰好遗漏 resume —— 必须拒绝，不得默认补值
      expectReject((i) => {
        (i.interaction as Record<string, unknown>).resume = undefined;
      });

      const falseVariant = contract();
      (falseVariant.interaction as Record<string, unknown>).streaming_transport = false;
      const facts = parsePublicAgentContract(falseVariant);
      expect(facts.interaction.streamingTransport).toBe(false);
    });

    it("supported_locales 缺失/空/非法 locale 拒绝", () => {
      expectReject((i) => {
        (i.interaction as Record<string, unknown>).supported_locales = undefined;
      });
      expectReject((i) => {
        (i.interaction as Record<string, unknown>).supported_locales = [];
      });
      expectReject((i) => {
        (i.interaction as Record<string, unknown>).supported_locales = ["zh", "zh"];
      });
      expectReject((i) => {
        (i.interaction as Record<string, unknown>).supported_locales = ["zh_CN"];
      });
    });

    it("result_contract fields/error_codes 空或重复、未知键拒绝", () => {
      expectReject((i) => {
        i.result_contract = { fields: [], error_codes: ["E1"] };
      });
      expectReject((i) => {
        i.result_contract = { fields: ["a"], error_codes: [] };
      });
      expectReject((i) => {
        i.result_contract = { fields: ["a", "a"], error_codes: ["E1"] };
      });
      expectReject((i) => {
        i.result_contract = { fields: ["a"], error_codes: ["E1", "E1"] };
      });
      expectReject((i) => {
        (i.result_contract as Record<string, unknown>).schema = { type: "object" };
      });
    });
  });
});
