ALTER TABLE "price_chart" DROP CONSTRAINT "price_chart_interval";--> statement-breakpoint
ALTER TABLE "price_chart" DROP CONSTRAINT "price_chart_range";--> statement-breakpoint
ALTER TABLE "price_chart" ADD CONSTRAINT "price_chart_interval" CHECK ("price_chart"."interval" IN ('5m', '1h', '1d'));--> statement-breakpoint
ALTER TABLE "price_chart" ADD CONSTRAINT "price_chart_range" CHECK ("price_chart"."range" IN ('1d', '1w', '1m', '3m', '6m', '1y', '5y'));