CREATE TABLE `agent_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`threadId` text NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`delivery` text NOT NULL,
	`aggregate` text NOT NULL,
	`dedupe_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`threadId`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_inbox_pending` ON `agent_inbox` (`userId`,`threadId`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_pending_dedupe` ON `agent_inbox` (`userId`,`threadId`,`dedupe_key`,`status`);--> statement-breakpoint
CREATE TABLE `agent_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_memory_user_key_unique` ON `agent_memory` (`userId`,`key`);--> statement-breakpoint
CREATE TABLE `agent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`threadId` text NOT NULL,
	`userId` text NOT NULL,
	`runId` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`prompt` text NOT NULL,
	`tool` text,
	`tool_version` integer,
	`args` text,
	`result` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`threadId`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runId`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_requests_pending` ON `agent_requests` (`userId`,`threadId`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_tool_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`threadId` text NOT NULL,
	`userId` text NOT NULL,
	`tool` text NOT NULL,
	`tool_version` integer NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`threadId`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tool_grants_active` ON `agent_tool_grants` (`userId`,`threadId`,`tool`,`tool_version`,`status`);