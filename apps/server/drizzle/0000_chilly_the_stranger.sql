CREATE EXTENSION IF NOT EXISTS vector;
CREATE TYPE "public"."actor_provenance" AS ENUM('webhook_verified', 'credential_bound', 'client_claimed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."audit_resource_type" AS ENUM('concept', 'event', 'job', 'audit', 'project', 'key');--> statement-breakpoint
CREATE TYPE "public"."concept_status" AS ENUM('active', 'superseded', 'disputed', 'needs-review');--> statement-breakpoint
CREATE TYPE "public"."concept_type" AS ENUM('service', 'concept', 'decision', 'gotcha', 'convention', 'runbook');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('commit', 'pr', 'issue', 'pr_comment', 'repo_file', 'mcp_write', 'manual');--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."initiator_kind" AS ENUM('credential', 'connector');--> statement-breakpoint
CREATE TYPE "public"."job_event_status" AS ENUM('pending', 'compiled', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('ingest_event', 'ingest_batch', 'compilation');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."occurred_at_provenance" AS ENUM('provider', 'client', 'server');--> statement-breakpoint
CREATE TYPE "public"."principal_kind" AS ENUM('human', 'service');--> statement-breakpoint
CREATE TYPE "public"."source_channel" AS ENUM('github', 'cli', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('github_commit', 'github_pr', 'github_issue', 'github_pr_comment', 'cli_init', 'mcp_write');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"principal_id" text,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"all_projects" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"last_used_at" timestamp (3) with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_keys_least_privilege_ck" CHECK (("api_keys"."all_projects" = true AND "api_keys"."project_id" IS NULL) OR ("api_keys"."all_projects" = false AND "api_keys"."project_id" IS NOT NULL)),
	CONSTRAINT "api_keys_scope_superset_ck" CHECK (NOT ('read:payload' = ANY("api_keys"."scopes")) OR ('read' = ANY("api_keys"."scopes")))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"request_id" text NOT NULL,
	"principal_id" text,
	"credential_id" text,
	"action" text NOT NULL,
	"resource_type" "audit_resource_type" NOT NULL,
	"resource_id" text,
	"team_id" text NOT NULL,
	"project_id" text,
	"outcome" "audit_outcome" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_contributors" (
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"concept_uuid" uuid NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_contributors_concept_uuid_principal_id_pk" PRIMARY KEY("concept_uuid","principal_id")
);
--> statement-breakpoint
CREATE TABLE "concept_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"concept_uuid" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"ref" text,
	"repo" text,
	"commit_sha" text,
	"path" text,
	"at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"concept_uuid" uuid NOT NULL,
	"path" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"type" "concept_type" NOT NULL,
	"status" "concept_status" NOT NULL,
	"confidence" "confidence" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen" timestamp (3) with time zone NOT NULL,
	"last_confirmed" timestamp (3) with time zone NOT NULL,
	"supersedes_uuid" uuid,
	"embedding" vector(1536),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepts_tenant_uq" UNIQUE("team_id","project_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"channel" "source_channel" NOT NULL,
	"kind" "source_kind" NOT NULL,
	"source_event" text,
	"source_action" text,
	"delivery_id" text NOT NULL,
	"item_key" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"actor" jsonb,
	"actor_provenance" "actor_provenance" NOT NULL,
	"actor_principal_id" text,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"occurred_at_provenance" "occurred_at_provenance" NOT NULL,
	"ingested_by_credential_id" text,
	"ingested_by_principal_id" text,
	"payload" jsonb NOT NULL,
	"payload_bytes" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"envelope_version" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_tenant_uq" UNIQUE("team_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"status" "job_event_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"error" jsonb,
	"concept_uuids" uuid[],
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_events_job_id_event_id_pk" PRIMARY KEY("job_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"initiated_by_kind" "initiator_kind" NOT NULL,
	"initiated_by_credential_id" text,
	"initiated_by_principal_id" text,
	"initiated_by_connector" text,
	"idempotency_key" text,
	"idempotency_request_hash" text,
	"result_snapshot" jsonb,
	"event_count" integer NOT NULL,
	"error" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "jobs_tenant_uq" UNIQUE("team_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" "principal_kind" NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"provider_user_id" text NOT NULL,
	"display_login" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_team_id_uq" UNIQUE("team_id","id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_team_id_uq" UNIQUE("team_id","id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_principal_fk" FOREIGN KEY ("team_id","principal_id") REFERENCES "public"."principals"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_contributors" ADD CONSTRAINT "concept_contributors_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_contributors" ADD CONSTRAINT "concept_contributors_concept_fk" FOREIGN KEY ("team_id","project_id","concept_uuid") REFERENCES "public"."concepts"("team_id","project_id","uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_contributors" ADD CONSTRAINT "concept_contributors_principal_fk" FOREIGN KEY ("team_id","principal_id") REFERENCES "public"."principals"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_evidence" ADD CONSTRAINT "concept_evidence_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_evidence" ADD CONSTRAINT "concept_evidence_concept_fk" FOREIGN KEY ("team_id","project_id","concept_uuid") REFERENCES "public"."concepts"("team_id","project_id","uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_paths" ADD CONSTRAINT "concept_paths_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_paths" ADD CONSTRAINT "concept_paths_concept_fk" FOREIGN KEY ("team_id","project_id","concept_uuid") REFERENCES "public"."concepts"("team_id","project_id","uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_principal_fk" FOREIGN KEY ("team_id","actor_principal_id") REFERENCES "public"."principals"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_fk" FOREIGN KEY ("team_id","project_id","job_id") REFERENCES "public"."jobs"("team_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_event_fk" FOREIGN KEY ("team_id","project_id","event_id") REFERENCES "public"."events"("team_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_team_idx" ON "api_keys" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "audit_team_cursor_idx" ON "audit_log" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_project_cursor_idx" ON "audit_log" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "concept_contributors_filter_idx" ON "concept_contributors" USING btree ("project_id","principal_id");--> statement-breakpoint
CREATE INDEX "concept_evidence_concept_idx" ON "concept_evidence" USING btree ("concept_uuid");--> statement-breakpoint
CREATE INDEX "concept_evidence_path_idx" ON "concept_evidence" USING btree ("project_id","repo","path");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_paths_namespace_uq" ON "concept_paths" USING btree ("project_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_paths_current_uq" ON "concept_paths" USING btree ("concept_uuid") WHERE "concept_paths"."is_current" = true;--> statement-breakpoint
CREATE INDEX "concepts_cursor_idx" ON "concepts" USING btree ("project_id","last_confirmed","uuid");--> statement-breakpoint
CREATE INDEX "concepts_tags_gin" ON "concepts" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "concepts_embedding_hnsw" ON "concepts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "concepts_team_idx" ON "concepts" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_idempotency_uq" ON "events" USING btree ("project_id","channel","delivery_id","item_key");--> statement-breakpoint
CREATE INDEX "events_cursor_idx" ON "events" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "events_team_idx" ON "events" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_uq" ON "jobs" USING btree ("project_id","kind","idempotency_key") WHERE "jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_cursor_idx" ON "jobs" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_identity_uq" ON "principals" USING btree ("team_id","provider","provider_user_id");--> statement-breakpoint
CREATE INDEX "projects_team_idx" ON "projects" USING btree ("team_id");
