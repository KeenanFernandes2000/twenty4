CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended', 'banned', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('phone', 'email', 'apple', 'google');--> statement-breakpoint
CREATE TYPE "public"."comment_status" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."group_member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."group_member_status" AS ENUM('active', 'left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."group_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."media_processing_status" AS ENUM('uploaded', 'validating', 'valid', 'invalid', 'used', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('photo', 'video');--> statement-breakpoint
CREATE TYPE "public"."montage_status" AS ENUM('not_generated', 'generating', 'draft_ready', 'published', 'failed', 'deleted_by_user', 'removed_by_admin', 'expired');--> statement-breakpoint
CREATE TYPE "public"."reaction_type" AS ENUM('like', 'laugh', 'fire', 'heart', 'shocked');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('spam', 'harassment', 'hate', 'nudity', 'violence', 'self_harm', 'illegal', 'impersonation', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'under_review', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('montage', 'comment', 'user');--> statement-breakpoint
CREATE TYPE "public"."montage_theme" AS ENUM('Chill', 'Party', 'Clean', 'Travel', 'Fast Cut', 'Soft', 'Mellow', 'Random');--> statement-breakpoint
CREATE TYPE "public"."validation_status" AS ENUM('pending', 'valid', 'invalid');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"username" "citext" NOT NULL,
	"profile_photo_url" text,
	"email" "citext",
	"phone" text,
	"auth_provider" "auth_provider" NOT NULL,
	"account_status" "account_status" DEFAULT 'active' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"privacy_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_or_phone" CHECK ("users"."email" is not null or "users"."phone" is not null)
);
--> statement-breakpoint
CREATE TABLE "group_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 25 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "group_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "group_member_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"photo_url" text,
	"owner_id" uuid NOT NULL,
	"status" "group_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_media_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_bucket" date NOT NULL,
	"media_type" "media_type" NOT NULL,
	"storage_path" text NOT NULL,
	"original_timestamp" timestamp with time zone,
	"upload_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"validation_status" "validation_status" DEFAULT 'pending' NOT NULL,
	"processing_status" "media_processing_status" DEFAULT 'uploaded' NOT NULL,
	"device_time_suspicious" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"metadata_summary" jsonb,
	"expiry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "montage_group_visibility" (
	"montage_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "montage_group_visibility_montage_id_group_id_pk" PRIMARY KEY("montage_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "montage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_bucket" date NOT NULL,
	"video_path" text,
	"thumbnail_path" text,
	"duration_ms" integer,
	"status" "montage_status" DEFAULT 'not_generated' NOT NULL,
	"theme" "montage_theme",
	"music_id" text,
	"render_job_id" text,
	"edl" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"expiry_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"montage_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" "comment_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"montage_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "reaction_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"admin_action" text,
	"content_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_media_item" ADD CONSTRAINT "daily_media_item_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "montage_group_visibility" ADD CONSTRAINT "montage_group_visibility_montage_id_montage_id_fk" FOREIGN KEY ("montage_id") REFERENCES "public"."montage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "montage_group_visibility" ADD CONSTRAINT "montage_group_visibility_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "montage" ADD CONSTRAINT "montage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_montage_id_montage_id_fk" FOREIGN KEY ("montage_id") REFERENCES "public"."montage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_montage_id_montage_id_fk" FOREIGN KEY ("montage_id") REFERENCES "public"."montage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email") WHERE "users"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_uq" ON "users" USING btree ("phone") WHERE "users"."phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "group_invites_code_uq" ON "group_invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "daily_media_item_user_day_validation_idx" ON "daily_media_item" USING btree ("user_id","day_bucket","validation_status");--> statement-breakpoint
CREATE INDEX "montage_group_visibility_group_idx" ON "montage_group_visibility" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "montage_published_status_expiry_idx" ON "montage" USING btree ("status","expiry_at") WHERE "montage"."status" = 'published';--> statement-breakpoint
CREATE INDEX "montage_user_day_idx" ON "montage" USING btree ("user_id","day_bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "reaction_montage_user_uq" ON "reaction" USING btree ("montage_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "block_blocker_blocked_uq" ON "block" USING btree ("blocker_id","blocked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_user_key_uq" ON "idempotency_key" USING btree ("user_id","key");