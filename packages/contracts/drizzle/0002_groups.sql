CREATE TYPE "public"."group_member_status" AS ENUM('active', 'left', 'removed');
CREATE TYPE "public"."group_role" AS ENUM('owner', 'admin', 'member');
CREATE TYPE "public"."group_status" AS ENUM('active', 'archived');
CREATE TABLE "group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"photo_url" text,
	"owner_id" uuid NOT NULL,
	"status" "group_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "group_invite" (
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

CREATE TABLE "group_member" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "group_role" DEFAULT 'member' NOT NULL,
	"status" "group_member_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_member_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);

ALTER TABLE "group" ADD CONSTRAINT "group_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "group_invite" ADD CONSTRAINT "group_invite_group_id_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "group_invite" ADD CONSTRAINT "group_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_group_id_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "group_invite_code_unique_idx" ON "group_invite" USING btree ("code");
CREATE INDEX "group_invite_group_id_live_idx" ON "group_invite" USING btree ("group_id") WHERE "group_invite"."revoked_at" IS NULL;
CREATE INDEX "group_member_user_id_idx" ON "group_member" USING btree ("user_id");
