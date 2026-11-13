-- Ask AI through the person's claude.ai plan (N275, ADR 0095): no key, opens claude.ai.
ALTER TABLE "ai_assistant" DROP CONSTRAINT "ai_assistant_provider";--> statement-breakpoint
ALTER TABLE "ai_assistant" ADD CONSTRAINT "ai_assistant_provider" CHECK ("ai_assistant"."provider" in ('muse', 'claude_ai', 'anthropic', 'openai', 'openai_compatible'));