-- P2-5: ThreadRunSkill (runId, skillId, role) 唯一约束,防 saveThreadRunSkills 重试插重复行
CREATE UNIQUE INDEX `ThreadRunSkill_runId_skillId_role_uq` ON `ThreadRunSkill` (`runId`,`skillId`,`role`);
