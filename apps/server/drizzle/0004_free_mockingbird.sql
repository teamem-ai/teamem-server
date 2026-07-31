CREATE TABLE "llm_config" (
	"team_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"api_key_encrypted" text,
	"embedding_available" boolean DEFAULT false NOT NULL,
	"last_test_ok" boolean,
	"last_test_latency_ms" integer,
	"last_test_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_config" ADD CONSTRAINT "llm_config_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;