ALTER TYPE "public"."identity_provider" ADD VALUE 'external';--> statement-breakpoint
ALTER TYPE "public"."source_channel" ADD VALUE 'external';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'external_event';--> statement-breakpoint
DROP INDEX "events_idempotency_uq";--> statement-breakpoint
DROP INDEX "principals_identity_uq";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "connector_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "provider_kind" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_idempotency_uq" ON "events" USING btree ("project_id","channel","connector_kind","delivery_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_identity_uq" ON "principals" USING btree ("team_id","provider","provider_kind","provider_user_id");