CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`name` text,
	`picture` text,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_login_at` integer,
	`disabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `passkeys` ADD `user_email` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_email` text;--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_email`);