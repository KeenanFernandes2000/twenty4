CREATE TYPE "public"."media_type" AS ENUM('photo', 'video');
CREATE TYPE "public"."processing_status" AS ENUM('uploaded', 'validating', 'valid', 'invalid', 'used', 'deleted', 'failed');
CREATE TYPE "public"."validation_status" AS ENUM('pending', 'valid', 'invalid');
CREATE TABLE "daily_media_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_bucket" date NOT NULL,
	"media_type" "media_type" NOT NULL,
	"storage_path" text NOT NULL,
	"original_timestamp" timestamp with time zone,
	"upload_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"validation_status" "validation_status" DEFAULT 'pending' NOT NULL,
	"processing_status" "processing_status" DEFAULT 'uploaded' NOT NULL,
	"duration_ms" integer,
	"metadata_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"byte_size" bigint,
	"expiry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "daily_media_item" ADD CONSTRAINT "daily_media_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "daily_media_item_user_day_validation_idx" ON "daily_media_item" USING btree ("user_id","day_bucket","validation_status");
