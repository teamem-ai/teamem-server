ALTER TYPE "public"."identity_provider" ADD VALUE 'external';--> statement-breakpoint
ALTER TYPE "public"."source_channel" ADD VALUE 'external';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'external_event';--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "connector_kind" text;--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "provider_kind" text;--> statement-breakpoint
UPDATE "events" SET "connector_kind" = "channel"::text WHERE "connector_kind" IS NULL;--> statement-breakpoint
UPDATE "principals" SET "provider_kind" = "provider"::text WHERE "provider_kind" IS NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "connector_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "principals" ALTER COLUMN "provider_kind" SET NOT NULL;--> statement-breakpoint
DROP INDEX "events_idempotency_uq";--> statement-breakpoint
DROP INDEX "principals_identity_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "events_idempotency_uq" ON "events" USING btree ("project_id","channel","connector_kind","delivery_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_identity_uq" ON "principals" USING btree ("team_id","provider","provider_kind","provider_user_id");
