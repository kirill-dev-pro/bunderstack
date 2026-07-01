ALTER TABLE `canvas` ADD `ownerId` text NOT NULL REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `canvas` DROP COLUMN `description`;