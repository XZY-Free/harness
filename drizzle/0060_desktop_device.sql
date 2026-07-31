-- V10 Phase 5：Desktop 设备绑定表。
-- 记录已绑定的 Desktop 设备公钥、userId、版本和撤销状态。
-- 长期设备私钥只存 Desktop Keychain，不写 DB（约束 6）。
-- deviceId 唯一：Desktop 本地生成设备标识（uuid 或稳定硬件指纹）。
-- userId 外键级联删除：用户删除时同步清理设备绑定。
CREATE TABLE `DesktopDevice` (
  `id` varchar(36) NOT NULL,
  `userId` varchar(36) NOT NULL,
  `deviceId` varchar(128) NOT NULL,
  `publicKey` text NOT NULL,
  `name` varchar(256) NOT NULL,
  `version` varchar(32) NOT NULL,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `lastActiveAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revokedAt` datetime NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY(`id`),
  UNIQUE KEY `DesktopDevice_deviceId_uq`(`deviceId`),
  KEY `DesktopDevice_userId_idx`(`userId`),
  KEY `DesktopDevice_status_idx`(`status`),
  CONSTRAINT `DesktopDevice_userId_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
