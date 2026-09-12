CREATE TABLE IF NOT EXISTS "shift_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"start_date" date NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"source" varchar(16) DEFAULT 'discord' NOT NULL,
	"discord_user_id" varchar(20),
	"discord_username" varchar(64),
	"closed_by_discord_id" varchar(20),
	"close_reason" varchar(32),
	"applied" boolean DEFAULT false NOT NULL,
	"note" varchar(200),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "shift_sessions" ADD CONSTRAINT "shift_sessions_staff_member_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shift_sessions_open_unique_idx" ON "shift_sessions" ("staff_member_id") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shift_sessions_staff_date_idx" ON "shift_sessions" ("staff_member_id","start_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shift_sessions_open_idx" ON "shift_sessions" ("ended_at") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shift_sessions_date_idx" ON "shift_sessions" ("start_date");--> statement-breakpoint
ALTER TABLE "hour_entries" ADD COLUMN IF NOT EXISTS "seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "hour_entries" SET "seconds" = "minutes" * 60 WHERE "seconds" = 0 AND "minutes" > 0;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN IF NOT EXISTS "discord_user_id" varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_members_discord_idx" ON "staff_members" ("discord_user_id") WHERE "discord_user_id" IS NOT NULL AND "archived_at" IS NULL;
