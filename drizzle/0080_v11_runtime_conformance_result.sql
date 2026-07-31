-- V11 Stage 5 S05-C06: runtime_conformance_result 表（RuntimeRevision 一致性测试结果）
--
-- 事实源：lib/v11/schema/runtime.ts、
--         docs/solutions/v11-agentkit-platform/10-core-data-model.md §6.x、
--         docs/solutions/v11-agentkit-platform/15-machine-contracts.md §5 L94-110
--
-- 关键约束：
-- - UNIQUE(runtimeRevisionId, caseId)：每个 Revision 每个 case 只有一条结果（UPSERT 语义）。
-- - conformance case id 必须唯一（与 ALL_CONFORMANCE_CASES 对应）。
-- - mandatory case 失败 → Revision 不可路由（由 publishRuntimeRevision 校验）。
-- - 失败 case 对应 capability 必须设为 false（应用层联动，本表不强制）。
-- - 可选能力缺失只禁用对应功能，不阻断发布。
-- - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
CREATE TABLE `V11RuntimeConformanceResult` (
  `id` varchar(36) NOT NULL,
  `runtimeRevisionId` varchar(36) NOT NULL,
  `tenantId` varchar(36) NOT NULL,
  `caseId` varchar(64) NOT NULL,
  `passed` boolean NOT NULL,
  `reason` text NULL,
  `adapterDigest` varchar(128) NULL,
  `testEnvironment` varchar(128) NULL,
  `evidenceRef` varchar(512) NULL,
  `testedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `V11RuntimeConformanceResult_revision_case_uq`(`runtimeRevisionId`,`caseId`),
  KEY `V11RuntimeConformanceResult_revision_idx`(`runtimeRevisionId`),
  KEY `V11RuntimeConformanceResult_case_passed_idx`(`caseId`,`passed`),
  CONSTRAINT `V11RuntimeConformanceResult_runtimeRevisionId_fk` FOREIGN KEY (`runtimeRevisionId`) REFERENCES `V11RuntimeRevision`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `V11RuntimeConformanceResult_tenantId_fk` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
