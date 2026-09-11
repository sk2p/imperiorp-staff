ALTER TABLE "hour_entries" DROP CONSTRAINT "hour_entries_minutes_positive";--> statement-breakpoint
ALTER TABLE "hour_entries" ADD COLUMN "status" varchar(16) DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_rates" ADD COLUMN "color" varchar(7) DEFAULT '#6f747d' NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_staff_records" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "weekly_staff_records" DROP COLUMN "status_note";--> statement-breakpoint
ALTER TABLE "hour_entries" ADD CONSTRAINT "hour_entries_minutes_non_negative" CHECK ("hour_entries"."minutes" >= 0);