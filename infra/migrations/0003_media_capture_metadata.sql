ALTER TABLE "daily_media_item" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "daily_media_item" ADD COLUMN "captured_in_app" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_media_item" ADD COLUMN "device_timezone" text;--> statement-breakpoint
ALTER TABLE "daily_media_item" ADD COLUMN "device_timestamp" timestamp with time zone;