/**
 * 企业属性目录（纯词表）。
 *
 * ENTERPRISE_ATTRIBUTE_CATALOG 是稳定协议目录：字段键、值类型、敏感位、
 * Agent 投影许可（agentProjectionAllowed）与指纹包含与否。本文件不依赖任何
 * 服务端模块（crypto/DB），供浏览器侧（Studio 资源页）与内核共用；
 * 完整企业资料域合同（校验/规范化/指纹）见 lib/identity/enterprise-user.ts（转导出本目录）。
 *
 * 企业权限和数据范围是授权事实，永远不允许作为 Agent 字段投影。
 * 新字段必须伴随本目录、同步模型与投影策略的同一版本变更，不能由上游自由透传。
 */

export const ENTERPRISE_ATTRIBUTE_KEYS = [
  "employeeNo",
  "departmentName",
  "buName",
  "jobName",
  "sourceSetId",

  "departmentCode",
  "buCode",
  "factoryCode",
  "jobLevel",
  "enterprisePermissions",
  "dataScopes",
  "authorizationGroups",
] as const;

export type EnterpriseAttributeKey = (typeof ENTERPRISE_ATTRIBUTE_KEYS)[number];
export type EnterpriseAttributeValueType = "string" | "number" | "boolean" | "json";

export interface EnterpriseAttributeDescriptor {
  key: EnterpriseAttributeKey;
  valueType: EnterpriseAttributeValueType;
  sensitive: boolean;
  agentProjectionAllowed: boolean;
  includedInFingerprint: boolean;
}

/**
 * 首批固定目录。
 */
export const ENTERPRISE_ATTRIBUTE_CATALOG: Readonly<
  Record<EnterpriseAttributeKey, EnterpriseAttributeDescriptor>
> = {
  departmentName: {
    key: "departmentName",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  buName: {
    key: "buName",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  jobName: {
    key: "jobName",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  sourceSetId: {
    key: "sourceSetId",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: false,
    includedInFingerprint: true,
  },
  authorizationGroups: {
    key: "authorizationGroups",
    valueType: "json",
    sensitive: true,
    agentProjectionAllowed: false,
    includedInFingerprint: true,
  },
  employeeNo: {
    key: "employeeNo",
    valueType: "string",
    sensitive: true,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  departmentCode: {
    key: "departmentCode",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  buCode: {
    key: "buCode",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  factoryCode: {
    key: "factoryCode",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  jobLevel: {
    key: "jobLevel",
    valueType: "string",
    sensitive: false,
    agentProjectionAllowed: true,
    includedInFingerprint: true,
  },
  enterprisePermissions: {
    key: "enterprisePermissions",
    valueType: "json",
    sensitive: true,
    agentProjectionAllowed: false,
    includedInFingerprint: true,
  },
  dataScopes: {
    key: "dataScopes",
    valueType: "json",
    sensitive: true,
    agentProjectionAllowed: false,
    includedInFingerprint: true,
  },
};
