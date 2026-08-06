-- §01: Runtime Conformance Run 改用 DSSE Envelope 字段替代 runnerSignature
ALTER TABLE `RuntimeConformanceRun`
  ADD COLUMN `envelopeDigest` varchar(71) NOT NULL DEFAULT '' AFTER `evidenceManifestDigest`,
  ADD COLUMN `envelopeJson` text NOT NULL AFTER `envelopeDigest`,
  ADD COLUMN `payloadDigest` varchar(71) NOT NULL DEFAULT '' AFTER `envelopeJson`,
  ADD COLUMN `signingKeyId` varchar(255) NOT NULL DEFAULT '' AFTER `payloadDigest`,
  ADD COLUMN `verificationEngine` varchar(64) NOT NULL DEFAULT '' AFTER `signingKeyId`,
  ADD COLUMN `verificationEngineVersion` varchar(32) NOT NULL DEFAULT '' AFTER `verificationEngine`,
  ADD COLUMN `predicateType` varchar(255) NOT NULL DEFAULT '' AFTER `verificationEngineVersion`,
  ADD COLUMN `verifiedAt` datetime(3) NOT NULL AFTER `predicateType`;
--> statement-breakpoint
ALTER TABLE `RuntimeConformanceRun` DROP COLUMN `runnerSignature`;
