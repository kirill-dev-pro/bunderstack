PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_likes` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`postId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_likes`("id", "userId", "postId", "createdAt") SELECT "id", "userId", "postId", "createdAt" FROM `likes`;--> statement-breakpoint
DROP TABLE `likes`;--> statement-breakpoint
ALTER TABLE `__new_likes` RENAME TO `likes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`imageUrl` text,
	`userId` text NOT NULL,
	`replyToId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`replyToId`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_posts`("id", "title", "body", "imageUrl", "userId", "replyToId", "createdAt") SELECT "id", "title", "body", "imageUrl", "userId", "replyToId", "createdAt" FROM `posts`;--> statement-breakpoint
DROP TABLE `posts`;--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;--> statement-breakpoint
CREATE TABLE `__new_retweets` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`postId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_retweets`("id", "userId", "postId", "createdAt") SELECT "id", "userId", "postId", "createdAt" FROM `retweets`;--> statement-breakpoint
DROP TABLE `retweets`;--> statement-breakpoint
ALTER TABLE `__new_retweets` RENAME TO `retweets`;