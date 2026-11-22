CREATE TABLE `ephemeral` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ephemeral_expires_idx` ON `ephemeral` (`expires_at`);--> statement-breakpoint
CREATE TABLE `timers` (
	`key` text PRIMARY KEY NOT NULL,
	`due_at` integer NOT NULL,
	`payload` text
);
