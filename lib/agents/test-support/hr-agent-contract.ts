/**
 * HR Agent Contract 测试夹具 — 真实首个集成（人力agent/hr-assistant）的登记事实。
 *
 * 事实源：/Users/sunshine/IdeaProjects/人力agent/hr-agent/artifacts/snowharness-registration/agent-contract.json
 * 逐字保留该 artifact 的中英文 description / notes；capabilities 不含
 * tags/examples/input_modes/output_modes，invocation_context 不含 trust_requirement /
 * declaration_source（wire 上缺席即缺席，不虚构）。
 *
 * 与当前 artifact 的唯一差异：interaction.resume 按冻结目标模型（batch 8 目标）显式为 true；
 * 现行 artifact 遗漏 resume —— 相关拒绝测试另行覆盖，不得默认补值。
 */

/** 代表性 HR 合同（管理员在登记时提供的完整请求体）。 */
export const hrAgentContract = {
  contract_version: "1.0.0",
  agent: {
    id: "hr-assistant",
    name: { "zh-CN": "企业人力智能助手", en: "Enterprise HR Assistant" },
    version: "1.0.0",
  },
  capabilities: [
    {
      key: "leave-and-attendance-service",
      name: { "zh-CN": "假勤与请假服务", en: "Leave and Attendance Service" },
      description: {
        "zh-CN":
          "请假申请、请假修改相关对话、补登、假期类型理解、日期与时长理解、排班/余额/资格校验后的办理、提交前确认、失败后的继续沟通。",
        en: "Leave requests, leave-modification conversations, retroactive entries, leave-type understanding, date and duration understanding, submission after schedule/balance/eligibility checks, pre-submit confirmation, and follow-up communication on failures.",
      },
    },
    {
      key: "employee-self-service",
      name: { "zh-CN": "员工本人信息服务", en: "Employee Self-Service" },
      description: {
        "zh-CN": "本人假期余额、本人医疗期、工龄信息、年假折算。",
        en: "The employee's own leave balance, medical period, service years, and annual-leave proration.",
      },
    },
    {
      key: "hr-policy-and-benefits-consultation",
      name: { "zh-CN": "人力制度与福利咨询", en: "HR Policy and Benefits Consultation" },
      description: {
        "zh-CN": "考勤制度、请假制度、入离职、试用期、薪酬、补贴、福利、地区差异类人力政策。",
        en: "Attendance rules, leave policies, onboarding and offboarding, probation, compensation, allowances, benefits, and region-specific HR policies.",
      },
    },
    {
      key: "hr-system-and-document-assistance",
      name: { "zh-CN": "人力系统与文档协助", en: "HR System and Document Assistance" },
      description: {
        "zh-CN": "人力系统操作说明、人力手册、人力文档问答、合法文档引用或附件辅助。",
        en: "HR system operation guides, HR handbook help, HR document Q&A, and lawful document-reference or attachment assistance.",
      },
    },
  ],
  invocation_context: [
    {
      key: "execution_subject",
      name: { "zh-CN": "执行主体" },
      necessity: "preferred",
      description: {
        "zh-CN":
          "SnowHarness本次执行所代表的可信调用者身份。制度咨询不一定需要身份；本人信息/请假办理需要身份。有可信身份且策略允许时尽量提供；没有身份时普通制度咨询仍可运行，本人数据或办理业务由智能体返回稳定身份缺失结果，不允许用户输入员工工号冒充可信身份。",
      },
      applies_to: ["leave-and-attendance-service", "employee-self-service"],
    },
    {
      key: "timezone",
      name: { "zh-CN": "时区" },
      necessity: "preferred",
      description: {
        "zh-CN": "用于“明天”“后天”“下周三”等相对日期和跨时区日期理解。",
      },
    },
    {
      key: "current_datetime",
      name: { "zh-CN": "当前时间" },
      necessity: "preferred",
      description: {
        "zh-CN":
          "本次执行的可信当前日期/时间。当前日期/时间在每次执行时确定，不在服务启动时冻结；如提供则优先使用。",
      },
    },
    {
      key: "locale",
      name: { "zh-CN": "语言区域" },
      necessity: "preferred",
      description: {
        "zh-CN": "正式支持语言为zh-CN。",
      },
    },
    {
      key: "conversation_summary",
      name: { "zh-CN": "对话摘要" },
      necessity: "preferred",
      description: {
        "zh-CN":
          "只在当前任务需要前文、平台有合法摘要、数据策略允许时提供。优先摘要/引用，不默认把整个会话历史全量复制给外部智能体。",
      },
    },
    {
      key: "attachment_references",
      name: { "zh-CN": "附件引用" },
      necessity: "accepted",
      description: {
        "zh-CN":
          "主要服务人力系统与文档协助。只在当前任务相关、调用方有权访问、合同允许、数据策略允许时发送引用；不默认把所有附件发送给智能体。",
      },
      applies_to: ["hr-system-and-document-assistance"],
    },
  ],
  interaction: {
    streaming_transport: true,
    incremental_content: false,
    input_required: true,
    resume: true,
    cancel: false,
    durable_task_recovery: false,
    supported_locales: ["zh-CN"],
  },
  result_contract: {
    fields: [
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
    ],
    error_codes: [
      "identity_required",
      "identity_unverified",
      "input_required",
      "not_found",
      "rejected",
      "temporarily_unavailable",
      "failed",
      "cancelled",
      "contract_error",
    ],
    notes: {
      "zh-CN":
        "answer为人类可读主回答；result_type为结果类别；data为可选结构化数据；actions为可选宿主可执行动作（第一版无通用动作协议时为空）；error_code为稳定机器错误；retryable表示是否适合重试。",
    },
  },
} as const;

export type HrAgentContract = typeof hrAgentContract;
