CREATE TABLE IF NOT EXISTS `_bunderstack_email_events` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`external_id` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `_bunderstack_emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `beev_external` ON `_bunderstack_email_events` (`external_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `beev_email_time` ON `_bunderstack_email_events` (`email_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_bunderstack_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text,
	`status` text NOT NULL,
	`from_address` text NOT NULL,
	`to_json` text NOT NULL,
	`cc_json` text NOT NULL,
	`bcc_json` text NOT NULL,
	`reply_to` text,
	`subject` text NOT NULL,
	`html` text,
	`text` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bem_created` ON `_bunderstack_emails` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bem_status` ON `_bunderstack_emails` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bem_provider_id` ON `_bunderstack_emails` (`provider`,`provider_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_bunderstack_jobs` (
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
CREATE INDEX IF NOT EXISTS `bjq_claim` ON `_bunderstack_jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bjq_type_status` ON `_bunderstack_jobs` (`type`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bjq_dedupe` ON `_bunderstack_jobs` (`type`,`dedupe_key`);--> statement-breakpoint
ALTER TABLE `account` ADD `issuer` text DEFAULT 'local:credential' NOT NULL;--> statement-breakpoint
-- Existing rows: Better Auth 1.7 derives a password account's issuer
-- from its provider id, so backfill rather than keep the column default.
UPDATE `account` SET `issuer` = 'local:' || `providerId`;