-- Data inputs part 2, item A (N322, ADR 0110): five more FRED series in rates_daily, one
-- nullable column each (a series has holidays of its own and a different start). tbill_3m becomes
-- nullable for the same reason: a day may now hold another series' value before DTB3 is kept.
ALTER TABLE "rates_daily" ALTER COLUMN "tbill_3m" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rates_daily" ADD COLUMN "credit_spread_ig" numeric;--> statement-breakpoint
ALTER TABLE "rates_daily" ADD COLUMN "credit_spread_hy" numeric;--> statement-breakpoint
ALTER TABLE "rates_daily" ADD COLUMN "term_spread_10y2y" numeric;--> statement-breakpoint
ALTER TABLE "rates_daily" ADD COLUMN "ust_10y" numeric;--> statement-breakpoint
ALTER TABLE "rates_daily" ADD COLUMN "ust_2y" numeric;--> statement-breakpoint
-- The market-level fill (N322): the regime factors are added to stored snapshot rows that predate
-- them. Only the values column, and the job only adds keys a row lacks (ADR 0110).
GRANT UPDATE ("values") ON "factor_snapshot" TO tm_secrets;
