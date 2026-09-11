ALTER TABLE "hour_entries" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "display_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_staff_records" ADD COLUMN "status" varchar(16) DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_staff_records" ADD COLUMN "status_note" varchar(200);--> statement-breakpoint
CREATE UNIQUE INDEX "hour_entries_day_unique_idx" ON "hour_entries" USING btree ("staff_member_id","week_id","work_date") WHERE voided_at is null;