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
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
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
CREATE INDEX `bjq_type_run_at` ON `_bunderstack_jobs` (`type`,`run_at`);
