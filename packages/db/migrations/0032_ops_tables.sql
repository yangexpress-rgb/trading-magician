CREATE TABLE "api_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_heartbeat" (
	"service" text PRIMARY KEY NOT NULL,
	"instance" text NOT NULL,
	"beat_at" timestamp with time zone NOT NULL
);
