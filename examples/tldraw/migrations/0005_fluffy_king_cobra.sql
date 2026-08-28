DROP TABLE `bunderstack_file_meta`;--> statement-breakpoint
DROP TABLE `_bunderstack_idempotency`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ownerId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_canvas`("id", "name", "ownerId", "createdAt", "updatedAt") SELECT "id", "name", "ownerId", "createdAt", "updatedAt" FROM `canvas`;--> statement-breakpoint
DROP TABLE `canvas`;--> statement-breakpoint
ALTER TABLE `__new_canvas` RENAME TO `canvas`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_presence` (
	`id` text PRIMARY KEY NOT NULL,
	`canvasId` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`x` integer,
	`y` integer,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_presence`("id", "canvasId", "name", "color", "x", "y", "updatedAt") SELECT "id", "canvasId", "name", "color", "x", "y", "updatedAt" FROM `presence`;--> statement-breakpoint
DROP TABLE `presence`;--> statement-breakpoint
ALTER TABLE `__new_presence` RENAME TO `presence`;--> statement-breakpoint
CREATE TABLE `__new_shape` (
	`id` text PRIMARY KEY NOT NULL,
	`canvasId` text NOT NULL,
	`ownerId` text,
	`type` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`rotation` integer NOT NULL,
	`color` text NOT NULL,
	`text` text,
	`imageFileId` text,
	`imageName` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_shape`("id", "canvasId", "ownerId", "type", "x", "y", "width", "height", "rotation", "color", "text", "imageFileId", "imageName", "createdAt", "updatedAt") SELECT "id", "canvasId", "ownerId", "type", "x", "y", "width", "height", "rotation", "color", "text", "imageFileId", "imageName", "createdAt", "updatedAt" FROM `shape`;--> statement-breakpoint
DROP TABLE `shape`;--> statement-breakpoint
ALTER TABLE `__new_shape` RENAME TO `shape`;--> statement-breakpoint
ALTER TABLE `account` ADD `issuer` text DEFAULT 'local:credential' NOT NULL;--> statement-breakpoint
-- Existing rows: Better Auth 1.7 derives a password account's issuer
-- from its provider id, so backfill rather than keep the column default.
UPDATE `account` SET `issuer` = 'local:' || `providerId`;