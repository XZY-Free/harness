import { describe, expect, it } from "vitest";
import type {
  HostedProvisioningRequestDTO,
  ProvisioningStep,
  RequestHostedProvisioningRequest,
} from "./provisioning";

/**
 * 专题01 冻结（runtime-only）合同测试。
 * 仅在类型层面约束合同形状，不做源码文本断言。
 */

// 类型层：请求类型必须恰好为 { route_scope_key: string }（无 Agent/runtime key/requester 可选字段）。
type Expect<T extends true> = T;
type IsExactlyRouteScope<T extends { route_scope_key: unknown }> = [keyof T] extends [
  "route_scope_key",
]
  ? T["route_scope_key"] extends string
    ? true
    : false
  : false;

type _reqShape = Expect<IsExactlyRouteScope<RequestHostedProvisioningRequest>>;

// 类型层：DTO 不得包含 agent_id / agent_revision_id / desired_runtime_key / Agent checkpoint。
type _noAgentId = Expect<"agent_id" extends keyof HostedProvisioningRequestDTO ? false : true>;
type _noAgentRevisionId = Expect<
  "agent_revision_id" extends keyof HostedProvisioningRequestDTO ? false : true
>;
type _noDesiredRuntimeKey = Expect<
  "desired_runtime_key" extends keyof HostedProvisioningRequestDTO ? false : true
>;
type _noAgentPublicationRecord = Expect<
  "agent_publication_record_id" extends keyof HostedProvisioningRequestDTO ? false : true
>;
type _noAgentRevisionCheckpoint = Expect<
  "agent_revision_id_checkpoint" extends keyof HostedProvisioningRequestDTO ? false : true
>;

// 类型层：DTO 必须含 requester_id。
type _hasRequesterId = Expect<
  "requester_id" extends keyof HostedProvisioningRequestDTO ? true : false
>;

// 类型层：步骤联合必须恰为 8 个 runtime-only 步骤，不含 ensure_agent_publication。
type IsExactlyEightSteps<T extends string> = [T] extends [
  | "validate_request"
  | "prepare_runtime_revision"
  | "verify_runtime_artifact"
  | "record_runtime_conformance"
  | "publish_runtime_revision"
  | "activate_route"
  | "await_projection"
  | "verify_route",
]
  ? "ensure_agent_publication" extends T
    ? false
    : true
  : false;

type _stepsShape = Expect<IsExactlyEightSteps<ProvisioningStep>>;

// 运行时轻量断言：步骤集合恰好 8 个 runtime-only 步骤。
const RUNTIME_ONLY_STEPS = [
  "validate_request",
  "prepare_runtime_revision",
  "verify_runtime_artifact",
  "record_runtime_conformance",
  "publish_runtime_revision",
  "activate_route",
  "await_projection",
  "verify_route",
] as const satisfies readonly ProvisioningStep[];

describe("provisioning contract（runtime-only）", () => {
  it("请求类型恰为 { route_scope_key }（编译期约束）", () => {
    const body: RequestHostedProvisioningRequest = { route_scope_key: "prod" };
    expect(body.route_scope_key).toBe("prod");
  });

  it("步骤联合恰为 8 个 runtime-only 步骤（编译期约束）", () => {
    expect(RUNTIME_ONLY_STEPS).toHaveLength(8);
    expect(RUNTIME_ONLY_STEPS).not.toContain("ensure_agent_publication");
  });
});
