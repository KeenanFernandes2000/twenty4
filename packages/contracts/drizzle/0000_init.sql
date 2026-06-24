-- twenty4 0000_init — extensions bootstrap + enum scaffolding only (no domain tables yet).
-- Extensions are hand-prepended (drizzle-kit does not emit them). citext: case-insensitive
-- text (emails/usernames); pgcrypto: gen_random_uuid() / crypto helpers. See M0 §4.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TYPE "public"."scaffold_status" AS ENUM('ok');
