-- §05.5: Add projectionContentDigest column for idempotent version control
-- Digest-based versioning: same digest → no version increase; digest change → version + 1

ALTER TABLE `RouteEligibilityProjection`
  ADD COLUMN `projectionContentDigest` varchar(71) NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  AFTER `invalidReason`;
--> statement-breakpoint
CREATE INDEX `RouteEligibilityProjection_contentDigest_idx`
  ON `RouteEligibilityProjection` (`projectionContentDigest`);
