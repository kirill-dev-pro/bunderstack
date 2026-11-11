CREATE TABLE `_bunderstack_broadcast_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`broadcast_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`address_id` text NOT NULL,
	`address` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `_bunderstack_broadcasts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bbr_address` ON `_bunderstack_broadcast_recipients` (`broadcast_id`,`address_id`);--> statement-breakpoint
CREATE INDEX `bbr_status` ON `_bunderstack_broadcast_recipients` (`broadcast_id`,`status`);--> statement-breakpoint
CREATE INDEX `bbr_created` ON `_bunderstack_broadcast_recipients` (`created_at`);--> statement-breakpoint
CREATE TABLE `_bunderstack_broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`from_address` text,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`text` text,
	`audience_json` text DEFAULT '{}' NOT NULL,
	`status` text NOT NULL,
	`scheduled_at` integer,
	`approved_by` text,
	`approved_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`recipients` integer DEFAULT 0 NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`opened` integer DEFAULT 0 NOT NULL,
	`clicked` integer DEFAULT 0 NOT NULL,
	`bounced` integer DEFAULT 0 NOT NULL,
	`complained` integer DEFAULT 0 NOT NULL,
	`unsubscribed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bbc_created` ON `_bunderstack_broadcasts` (`created_at`);--> statement-breakpoint
CREATE INDEX `bbc_status` ON `_bunderstack_broadcasts` (`status`);