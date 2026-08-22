-- §10.3 ExecutionBinding Agent Evidence 条件性完整组（all-or-nothing）。
-- drizzle-kit MySQL 不将 CHECK 约束作为可迁移变更，故手写此迁移落地 DB 层保证。
-- 约束：Agent Evidence 全部为空（base route，not_applicable，§18）或全部完整（agent route，§7.4）。
-- 禁止"随便 nullable"半完整组（禁 4 态模糊，§8.4）。
ALTER TABLE `ExecutionBinding` ADD CONSTRAINT `ExecutionBinding_agentEvidence_all_or_nothing` CHECK (
  (
    `agentRevisionId` IS NULL
    AND `agentArtifactId` IS NULL
    AND `agentArtifactDigest` IS NULL
    AND `agentAttestationIds` IS NULL
    AND `agentPublicationRecordId` IS NULL
  )
  OR
  (
    `agentRevisionId` IS NOT NULL
    AND `agentArtifactId` IS NOT NULL
    AND `agentArtifactDigest` IS NOT NULL
    AND JSON_TYPE(`agentAttestationIds`) = 'ARRAY'
    AND JSON_LENGTH(`agentAttestationIds`) >= 1
    AND `agentPublicationRecordId` IS NOT NULL
  )
);
