ALTER TABLE `agent_tool_calls` ADD `execution_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tool_calls_execution_unique` ON `agent_tool_calls` (`execution_id`);
