-- When the person dismissed the new-user guide card or watched the guide to the end
-- (N248, ADR 0088). Null means the card still shows on Strategy Lab.
ALTER TABLE "profile" ADD COLUMN "guide_video_done_at" timestamp with time zone;