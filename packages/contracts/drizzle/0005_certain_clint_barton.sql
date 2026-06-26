CREATE TYPE "public"."montage_status" AS ENUM('not_generated', 'generating', 'draft_ready', 'published', 'failed', 'deleted_by_user', 'removed_by_admin', 'expired');--> statement-breakpoint
CREATE TYPE "public"."theme" AS ENUM('chill', 'party', 'clean', 'travel', 'random', 'fast_cut', 'soft');--> statement-breakpoint
CREATE TABLE "montage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_bucket" date NOT NULL,
	"video_path" text,
	"thumbnail_path" text,
	"duration_ms" integer,
	"status" "montage_status" DEFAULT 'not_generated' NOT NULL,
	"theme" text NOT NULL,
	"music_id" text NOT NULL,
	"edl" jsonb,
	"source_media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"render_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"expiry_at" timestamp with time zone,
	CONSTRAINT "montage_published_expiry_check" CHECK (status <> 'published' OR expiry_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "montage_group_visibility" (
	"montage_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "montage_group_visibility_montage_id_group_id_pk" PRIMARY KEY("montage_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "daily_media_item" ADD COLUMN "thumbnail_path" text;--> statement-breakpoint
ALTER TABLE "montage" ADD CONSTRAINT "montage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "montage_group_visibility" ADD CONSTRAINT "montage_group_visibility_montage_id_montage_id_fk" FOREIGN KEY ("montage_id") REFERENCES "public"."montage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "montage_group_visibility" ADD CONSTRAINT "montage_group_visibility_group_id_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "montage_published_status_expiry_idx" ON "montage" USING btree ("status","expiry_at") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "montage_user_day_idx" ON "montage" USING btree ("user_id","day_bucket");