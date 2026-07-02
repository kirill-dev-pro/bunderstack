CREATE TABLE `presence` (
	`id` text PRIMARY KEY NOT NULL,
	`canvasId` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`x` integer,
	`y` integer,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`canvasId`) REFERENCES `canvas`(`id`) ON UPDATE no action ON DELETE cascade
);
