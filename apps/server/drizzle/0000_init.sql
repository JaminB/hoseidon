CREATE TABLE `device_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`at` integer NOT NULL,
	`status` text,
	`online` integer NOT NULL,
	`battery_pct` real,
	`signal_pct` real,
	`work_mode` text,
	`watering` integer DEFAULT false NOT NULL,
	`alarms` text DEFAULT '[]' NOT NULL,
	`raw` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_snapshots_device_at_idx` ON `device_snapshots` (`device_id`,`at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`gateway_id` text NOT NULL,
	`outlet` integer,
	`linktap_name` text NOT NULL,
	`name` text,
	`zone` text,
	`status` text,
	`online` integer DEFAULT false NOT NULL,
	`battery_pct` real,
	`signal_pct` real,
	`work_mode` text,
	`alarms` text DEFAULT '[]' NOT NULL,
	`watering` text,
	`last_seen_at` integer,
	`history_fetched_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `devices_gateway_idx` ON `devices` (`gateway_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`severity` text NOT NULL,
	`gateway_id` text,
	`device_id` text,
	`title` text NOT NULL,
	`message` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `events_device_at_idx` ON `events` (`device_id`,`at`);--> statement-breakpoint
CREATE TABLE `gateways` (
	`id` text PRIMARY KEY NOT NULL,
	`linktap_name` text NOT NULL,
	`name` text,
	`status` text,
	`online` integer DEFAULT false NOT NULL,
	`lat` real,
	`lon` real,
	`timezone` text,
	`last_seen_at` integer,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`planned_sec` integer,
	`duration_sec` integer,
	`volume_ml` real,
	`source` text NOT NULL,
	`schedule_id` integer,
	`status` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_device_started_idx` ON `runs` (`device_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
