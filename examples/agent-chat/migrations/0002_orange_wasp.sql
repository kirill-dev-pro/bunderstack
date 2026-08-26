ALTER TABLE `agent_requests` ADD `approval_id` text;--> statement-breakpoint
ALTER TABLE `agent_requests` ADD `tool_call_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `checkpoint` text;