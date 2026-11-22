ALTER TABLE `device_snapshots` ADD `flow_ml_per_min` real;--> statement-breakpoint
ALTER TABLE `devices` ADD `d_type` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `flow_meter` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `flow_ml_per_min` real;--> statement-breakpoint
ALTER TABLE `devices` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `gateways` ADD `location_source` text;--> statement-breakpoint
ALTER TABLE `gateways` ADD `location_raw` text;--> statement-breakpoint
ALTER TABLE `gateways` ADD `location_resolved_for` text;--> statement-breakpoint
ALTER TABLE `gateways` ADD `version` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `mode` text;--> statement-breakpoint
-- Locations saved before automatic detection existed were set by hand.
UPDATE `gateways` SET `location_source` = 'manual' WHERE `lat` IS NOT NULL AND `lon` IS NOT NULL;
