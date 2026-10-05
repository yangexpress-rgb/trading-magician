ALTER TABLE "broker_connection" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connection" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "broker_connection" ADD COLUMN "check_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broker_connection" ADD COLUMN "check_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_external_uq" UNIQUE("broker_connection_id","external_id");