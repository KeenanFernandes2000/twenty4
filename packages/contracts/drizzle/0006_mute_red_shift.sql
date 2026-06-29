CREATE TYPE "public"."comment_status" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."reaction_type" AS ENUM('like', 'laugh', 'fire', 'heart', 'shocked');--> statement-breakpoint
CREATE TABLE "block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"montage_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "comment_status" DEFAULT 'active' NOT NULL
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
ALTER TABLE "block" ADD CONSTRAINT "block_blocker_user_id_user_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block" ADD CONSTRAINT "block_blocked_user_id_user_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_montage_id_montage_id_fk" FOREIGN KEY ("montage_id") REFERENCES "public"."montage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_montage_id_montage_id_fk" FOREIGN KEY ("montage_id") REFERENCES "public"."montage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "block_blocker_blocked_unique_idx" ON "block" USING btree ("blocker_user_id","blocked_user_id");--> statement-breakpoint
CREATE INDEX "block_blocker_user_id_idx" ON "block" USING btree ("blocker_user_id");--> statement-breakpoint
CREATE INDEX "block_blocked_user_id_idx" ON "block" USING btree ("blocked_user_id");--> statement-breakpoint
CREATE INDEX "comment_montage_created_active_idx" ON "comment" USING btree ("montage_id","created_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "comment_user_id_idx" ON "comment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reaction_montage_user_unique_idx" ON "reaction" USING btree ("montage_id","user_id");--> statement-breakpoint
CREATE INDEX "reaction_montage_id_idx" ON "reaction" USING btree ("montage_id");--> statement-breakpoint
CREATE INDEX "reaction_user_id_idx" ON "reaction" USING btree ("user_id");