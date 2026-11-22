CREATE TABLE `planned_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schedule_id` integer NOT NULL,
	`device_id` text NOT NULL,
	`gateway_id` text NOT NULL,
	`occurrence_at` integer NOT NULL,
	`seq` integer NOT NULL,
	`cycle` integer NOT NULL,
	`planned_at` integer NOT NULL,
	`base_seconds` integer NOT NULL,
	`seconds` integer NOT NULL,
	`scale` real DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`skip_reason` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`weather_checked_at` integer,
	`run_id` integer,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_runs_slot_idx` ON `planned_runs` (`schedule_id`,`occurrence_at`,`seq`,`cycle`);--> statement-breakpoint
CREATE INDEX `planned_runs_status_idx` ON `planned_runs` (`status`);--> statement-breakpoint
CREATE INDEX `planned_runs_planned_at_idx` ON `planned_runs` (`planned_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`rrule` text NOT NULL,
	`dtstart` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`items` text NOT NULL,
	`cycle_soak` text,
	`sequential` integer DEFAULT true NOT NULL,
	`skip_rules` text NOT NULL,
	`gcal_event_id` text,
	`effective_from` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
