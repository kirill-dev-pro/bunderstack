CREATE TABLE `agent_commitment_dependencies` (
	`commitmentId` text NOT NULL,
	`dependsOnCommitmentId` text NOT NULL,
	FOREIGN KEY (`commitmentId`) REFERENCES `agent_commitments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dependsOnCommitmentId`) REFERENCES `agent_commitments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_commitment_dependency_unique` ON `agent_commitment_dependencies` (`commitmentId`,`dependsOnCommitmentId`);--> statement-breakpoint
ALTER TABLE `agent_commitments` ADD `execution_spec` text;--> statement-breakpoint
ALTER TABLE `agent_commitments` ADD `currentRunId` text;--> statement-breakpoint
ALTER TABLE `agent_commitments` ADD `result` text;--> statement-breakpoint
ALTER TABLE `agent_commitments` ADD `error` text;--> statement-breakpoint
ALTER TABLE `agent_commitments` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `agent_commitments` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `commitmentId` text REFERENCES agent_commitments(id);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `trigger_type` text;