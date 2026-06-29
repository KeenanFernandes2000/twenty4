CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"snapshot_path" text,
	"snapshot_metadata" jsonb,
	"retain_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "montage" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_retain_until_idx" ON "report" USING btree ("retain_until") WHERE snapshot_path IS NOT NULL;--> statement-breakpoint
CREATE INDEX "report_reporter_user_id_idx" ON "report" USING btree ("reporter_user_id");--> statement-breakpoint
ALTER TABLE "montage" ADD CONSTRAINT "montage_superseded_by_montage_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."montage"("id") ON DELETE set null ON UPDATE no action;