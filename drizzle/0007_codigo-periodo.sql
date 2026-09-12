UPDATE "weeks" SET "code" = "start_date"::text || '_' || "end_date"::text WHERE "code" <> "start_date"::text || '_' || "end_date"::text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "weeks" ADD CONSTRAINT "weeks_code_matches_dates" CHECK ("code" = "start_date"::text || '_' || "end_date"::text); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
