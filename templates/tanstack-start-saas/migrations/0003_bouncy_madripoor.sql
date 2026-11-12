CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`ownerId` text NOT NULL,
	`fileId` text NOT NULL,
	`filename` text NOT NULL,
	`contentType` text DEFAULT '' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ownerId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_fileId_unique` ON `attachments` (`fileId`);--> statement-breakpoint
ALTER TABLE `projects` ADD `coverUrl` text;