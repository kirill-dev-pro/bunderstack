CREATE TABLE `bunderstack_file_meta` (
	`file_id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`owner_id` text,
	`scope_json` text,
	`status` text NOT NULL,
	`filename` text,
	`content_type` text,
	`size` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `bfm_owner` ON `bunderstack_file_meta` (`owner_id`);--> statement-breakpoint
CREATE INDEX `bfm_scope` ON `bunderstack_file_meta` (`bucket`,`scope_json`);--> statement-breakpoint
CREATE INDEX `bfm_sweep` ON `bunderstack_file_meta` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `_bunderstack_idempotency` (
	`key` text NOT NULL,
	`table_name` text NOT NULL,
	`body_hash` text NOT NULL,
	`status` integer NOT NULL,
	`response` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`key`, `table_name`)
);
--> statement-breakpoint
CREATE TABLE `_bunderstack_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`locked_until` integer,
	`dedupe_key` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `bjq_claim` ON `_bunderstack_jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `bjq_type_status` ON `_bunderstack_jobs` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `bjq_type_run_at` ON `_bunderstack_jobs` (`type`,`run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `bjq_dedupe` ON `_bunderstack_jobs` (`type`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `_bunderstack_message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`external_id` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `_bunderstack_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bmev_external` ON `_bunderstack_message_events` (`external_id`);--> statement-breakpoint
CREATE INDEX `bmev_message_time` ON `_bunderstack_message_events` (`message_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `_bunderstack_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`credential_source` text NOT NULL,
	`provider_id` text,
	`status` text NOT NULL,
	`recipients_json` text NOT NULL,
	`content_json` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bmsg_created` ON `_bunderstack_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `bmsg_channel_status` ON `_bunderstack_messages` (`channel`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `bmsg_provider_id` ON `_bunderstack_messages` (`provider`,`provider_id`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`name` text NOT NULL,
	`clientName` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'brief' NOT NULL,
	`dueAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ownerId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`ownerId` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ownerId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
