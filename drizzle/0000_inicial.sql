CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"actor_id" uuid,
	"actor_username" varchar(32) NOT NULL,
	"actor_role" varchar(24),
	"action" varchar(48) NOT NULL,
	"entity" varchar(40) NOT NULL,
	"entity_id" varchar(64) NOT NULL,
	"summary" varchar(240) NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_fields" jsonb,
	"reason" text,
	"metadata" jsonb,
	"ip" varchar(45),
	"user_agent" text,
	"trace_id" varchar(32),
	"hash_prev" varchar(64),
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hour_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"reason" varchar(200) NOT NULL,
	"recorded_by" uuid,
	"recorded_by_username" varchar(32) NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"import_batch_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hour_entries_minutes_positive" CHECK ("hour_entries"."minutes" > 0),
	CONSTRAINT "hour_entries_minutes_max" CHECK ("hour_entries"."minutes" <= 1440)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(16) NOT NULL,
	"filename" varchar(200) NOT NULL,
	"week_id" uuid,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"skipped_rows" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"errors" jsonb,
	"imported_by" uuid,
	"imported_by_username" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_key" varchar(120) NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"weekly_record_id" uuid,
	"amount" bigint NOT NULL,
	"expected_amount" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"paid_by" uuid,
	"paid_by_username" varchar(32) NOT NULL,
	"method" varchar(20) DEFAULT 'in_game' NOT NULL,
	"payment_reference" varchar(80),
	"notes" text,
	"idempotency_key" varchar(64) NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "rank_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rank" varchar(8) NOT NULL,
	"previous_rate" bigint,
	"new_rate" bigint NOT NULL,
	"reason" text,
	"changed_by" uuid,
	"changed_by_username" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_rates" (
	"rank" varchar(8) PRIMARY KEY NOT NULL,
	"category" varchar(20) NOT NULL,
	"label" varchar(60) NOT NULL,
	"rate_per_hour" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "rank_rates_positive" CHECK ("rank_rates"."rate_per_hour" > 0)
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"severity" varchar(12) DEFAULT 'info' NOT NULL,
	"user_id" uuid,
	"username" varchar(32),
	"ip" varchar(45),
	"user_agent" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"ip" varchar(45),
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"rank" varchar(8) NOT NULL,
	"category" varchar(20) NOT NULL,
	"in_game_id" varchar(40),
	"discord_tag" varchar(40),
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"joined_at" date,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_rank_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"from_rank" varchar(8),
	"to_rank" varchar(8) NOT NULL,
	"change_type" varchar(12) NOT NULL,
	"reason" text,
	"changed_by" uuid,
	"changed_by_username" varchar(32) NOT NULL,
	"week_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"value_type" varchar(12) DEFAULT 'string' NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(32) NOT NULL,
	"display_name" varchar(80),
	"password_hash" text NOT NULL,
	"role" varchar(24) DEFAULT 'MANAGER' NOT NULL,
	"granted_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revoked_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip" varchar(45),
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_failed_login_non_negative" CHECK ("users"."failed_login_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_staff_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_id" uuid NOT NULL,
	"staff_member_id" uuid NOT NULL,
	"staff_name_snapshot" varchar(80) NOT NULL,
	"rank_snapshot" varchar(8) NOT NULL,
	"category_snapshot" varchar(20) NOT NULL,
	"hourly_rate_snapshot" bigint NOT NULL,
	"total_minutes" integer DEFAULT 0 NOT NULL,
	"calculated_amount" bigint DEFAULT 0 NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"frozen_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_records_minutes_non_negative" CHECK ("weekly_staff_records"."total_minutes" >= 0),
	CONSTRAINT "weekly_records_amount_non_negative" CHECK ("weekly_staff_records"."calculated_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(24) NOT NULL,
	"label" varchar(80),
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"notes" text,
	"frozen_total_minutes" integer,
	"frozen_total_amount" bigint,
	"frozen_member_count" integer,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	"reopen_count" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weeks_date_order" CHECK ("weeks"."start_date" <= "weeks"."end_date"),
	CONSTRAINT "weeks_status_values" CHECK ("weeks"."status" in ('open', 'closed')),
	CONSTRAINT "weeks_closed_has_snapshot" CHECK (("weeks"."status" = 'open') or ("weeks"."closed_at" is not null and "weeks"."frozen_total_amount" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_entries" ADD CONSTRAINT "hour_entries_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_entries" ADD CONSTRAINT "hour_entries_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_entries" ADD CONSTRAINT "hour_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_entries" ADD CONSTRAINT "hour_entries_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_weekly_record_id_weekly_staff_records_id_fk" FOREIGN KEY ("weekly_record_id") REFERENCES "public"."weekly_staff_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_rate_history" ADD CONSTRAINT "rank_rate_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_rates" ADD CONSTRAINT "rank_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_rank_history" ADD CONSTRAINT "staff_rank_history_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_rank_history" ADD CONSTRAINT "staff_rank_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_staff_records" ADD CONSTRAINT "weekly_staff_records_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_staff_records" ADD CONSTRAINT "weekly_staff_records_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weeks" ADD CONSTRAINT "weeks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weeks" ADD CONSTRAINT "weeks_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weeks" ADD CONSTRAINT "weeks_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_sequence_idx" ON "audit_logs" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "hour_entries_week_staff_idx" ON "hour_entries" USING btree ("week_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "hour_entries_staff_date_idx" ON "hour_entries" USING btree ("staff_member_id","work_date");--> statement-breakpoint
CREATE INDEX "hour_entries_week_date_idx" ON "hour_entries" USING btree ("week_id","work_date");--> statement-breakpoint
CREATE INDEX "hour_entries_recorded_by_idx" ON "hour_entries" USING btree ("recorded_by");--> statement-breakpoint
CREATE INDEX "hour_entries_created_idx" ON "hour_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "import_batches_created_idx" ON "import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_bucket_idx" ON "login_attempts" USING btree ("bucket_key");--> statement-breakpoint
CREATE INDEX "login_attempts_locked_idx" ON "login_attempts" USING btree ("locked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_week_staff_active_idx" ON "payments" USING btree ("week_id","staff_member_id") WHERE voided_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_idx" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_week_idx" ON "payments" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "payments_staff_idx" ON "payments" USING btree ("staff_member_id");--> statement-breakpoint
CREATE INDEX "payments_paid_at_idx" ON "payments" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "rank_rate_history_rank_idx" ON "rank_rate_history" USING btree ("rank","created_at");--> statement-breakpoint
CREATE INDEX "security_events_created_idx" ON "security_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "security_events_type_idx" ON "security_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "security_events_severity_idx" ON "security_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "security_events_username_idx" ON "security_events" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_members_name_active_idx" ON "staff_members" USING btree (lower("name")) WHERE "staff_members"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "staff_members_rank_idx" ON "staff_members" USING btree ("rank");--> statement-breakpoint
CREATE INDEX "staff_members_active_idx" ON "staff_members" USING btree ("active");--> statement-breakpoint
CREATE INDEX "staff_members_category_idx" ON "staff_members" USING btree ("category");--> statement-breakpoint
CREATE INDEX "staff_rank_history_member_idx" ON "staff_rank_history" USING btree ("staff_member_id","created_at");--> statement-breakpoint
CREATE INDEX "staff_rank_history_created_idx" ON "staff_rank_history" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_active_idx" ON "users" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_records_week_staff_idx" ON "weekly_staff_records" USING btree ("week_id","staff_member_id");--> statement-breakpoint
CREATE INDEX "weekly_records_week_idx" ON "weekly_staff_records" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "weekly_records_staff_idx" ON "weekly_staff_records" USING btree ("staff_member_id");--> statement-breakpoint
CREATE INDEX "weekly_records_rank_idx" ON "weekly_staff_records" USING btree ("rank_snapshot");--> statement-breakpoint
CREATE UNIQUE INDEX "weeks_code_idx" ON "weeks" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "weeks_range_idx" ON "weeks" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "weeks_status_idx" ON "weeks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "weeks_start_date_idx" ON "weeks" USING btree ("start_date");