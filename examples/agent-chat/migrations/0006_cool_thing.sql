CREATE TABLE `agent_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`runId` text NOT NULL,
	`threadId` text NOT NULL,
	`userId` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`status` text NOT NULL,
	`visibility` text DEFAULT 'visible' NOT NULL,
	`input` text,
	`output` text,
	`toolCallId` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`runId`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`threadId`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_steps_run_sequence_unique` ON `agent_run_steps` (`runId`,`sequence`);--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `runId` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `client_message_id` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `status` text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_thread_client_message_unique` ON `agent_messages` (`threadId`,`client_message_id`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `inputMessageId` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `assistantMessageId` text;--> statement-breakpoint
UPDATE `agent_runs` SET `status` = 'complete' WHERE `status` = 'done';--> statement-breakpoint
UPDATE `agent_runs` SET `status` = 'error' WHERE `status` = 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_one_active_user_message_unique` ON `agent_runs` (`threadId`) WHERE "agent_runs"."trigger_type" = 'user_message' and "agent_runs"."status" in ('queued', 'running', 'waiting_for_approval', 'cancelling');
