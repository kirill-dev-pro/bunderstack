CREATE TABLE `_bunderstack_contact_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`kind` text NOT NULL,
	`address` text NOT NULL,
	`consented_at` integer,
	`consent_source` text,
	`unsubscribed_at` integer,
	`suppressed_at` integer,
	`suppressed_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `_bunderstack_contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bca_address` ON `_bunderstack_contact_addresses` (`kind`,`address`);--> statement-breakpoint
CREATE INDEX `bca_contact` ON `_bunderstack_contact_addresses` (`contact_id`);--> statement-breakpoint
CREATE TABLE `_bunderstack_contact_tags` (
	`contact_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`contact_id`, `tag`),
	FOREIGN KEY (`contact_id`) REFERENCES `_bunderstack_contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bctag_tag` ON `_bunderstack_contact_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `_bunderstack_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`user_id` text,
	`source` text,
	`attributes_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bct_created` ON `_bunderstack_contacts` (`created_at`);--> statement-breakpoint
CREATE INDEX `bct_source` ON `_bunderstack_contacts` (`source`);--> statement-breakpoint
CREATE INDEX `bct_user` ON `_bunderstack_contacts` (`user_id`);--> statement-breakpoint
DROP INDEX `bjq_type_status`;--> statement-breakpoint
CREATE INDEX `bjq_ready` ON `_bunderstack_jobs` (`type`,`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `bjq_reap` ON `_bunderstack_jobs` (`status`,`finished_at`);