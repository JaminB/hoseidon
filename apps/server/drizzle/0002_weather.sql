CREATE TABLE `weather_daily` (
	`location_key` text NOT NULL,
	`date` text NOT NULL,
	`rain_mm` real,
	`rain_prob_pct` real,
	`et0_mm` real,
	`t_max_c` real,
	`t_min_c` real,
	`wind_max_kph` real,
	`soil_moisture` real,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weather_daily_loc_date_idx` ON `weather_daily` (`location_key`,`date`);