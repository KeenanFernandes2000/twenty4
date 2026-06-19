ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "resolved_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "snapshot_purge_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "report_reporter_target_open_uq" ON "report" USING btree ("reporter_id","target_type","target_id") WHERE "report"."status" = 'open';