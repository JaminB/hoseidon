CREATE TABLE `gcal_account` (
	`id` integer PRIMARY KEY NOT NULL,
	`refresh_token_enc` text,
	`scope` text,
	`calendar_id` text,
	`connected_at` integer,
	`needs_reconnect` integer DEFAULT false NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gcal_events` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`event_id` text,
	`hash` text NOT NULL,
	`at` integer,
	`synced_at` integer NOT NULL
);
