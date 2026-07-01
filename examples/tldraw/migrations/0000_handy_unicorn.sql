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
CREATE TABLE `canvas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
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
CREATE TABLE `shape` (
	`id` text PRIMARY KEY NOT NULL,
	`canvasId` text NOT NULL,
	`type` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`rotation` integer NOT NULL,
	`color` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`canvasId`) REFERENCES `canvas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`about` text DEFAULT '',
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
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
