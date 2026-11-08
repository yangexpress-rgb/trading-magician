ALTER TABLE "strategy_library_revisions" DROP CONSTRAINT "strategy_library_revisions_action";--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "library_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_library_entry_id_strategy_library_entries_id_fk" FOREIGN KEY ("library_entry_id") REFERENCES "public"."strategy_library_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_library_entry_uq" ON "strategy" USING btree ("library_entry_id") WHERE "strategy"."library_entry_id" is not null and "strategy"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "strategy_library_revisions" ADD CONSTRAINT "strategy_library_revisions_action" CHECK ("strategy_library_revisions"."action" in ('create', 'edit', 'retire'));--> statement-breakpoint
-- Strategy Lab numbering (ADR 0054). The strategy now names its Library record;
-- the record's built link mirrors it. Links made before this (library:link-seed
-- or the Library's edit form) carry over: the record that linked a live strategy
-- in its owner's workspace becomes that strategy's record (the earliest number,
-- should one strategy have been linked twice). Nothing else is numbered here:
-- every other strategy gets its record on its next save.
UPDATE "strategy" s SET "library_entry_id" = l.id
  FROM (
    SELECT DISTINCT ON (e.built_strategy_id) e.id, e.built_strategy_id, e.built_strategy_owner
      FROM "strategy_library_entries" e
     WHERE e.built_strategy_id IS NOT NULL
     ORDER BY e.built_strategy_id, e.sequence_no
  ) l
 WHERE s.id = l.built_strategy_id AND s.user_id = l.built_strategy_owner AND s.deleted_at IS NULL;
