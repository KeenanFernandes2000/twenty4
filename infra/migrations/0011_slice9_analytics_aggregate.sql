CREATE TABLE "analytics_aggregate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"day" date NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_aggregate_event_day_dim_uq" ON "analytics_aggregate" USING btree ("event_type","day","dimension");