CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "email_domain" text NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_created_by_user_id_app_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");
CREATE UNIQUE INDEX "organizations_email_domain_lower_unique" ON "organizations" USING btree (lower("email_domain"));
CREATE INDEX "organizations_created_by_idx" ON "organizations" USING btree ("created_by_user_id");

INSERT INTO "organizations" ("name", "slug", "email_domain")
VALUES ('Orinlabs', 'orinlabs', 'orinlabs.ai')
ON CONFLICT ("slug") DO NOTHING;

CREATE TABLE "organization_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_user_id_app_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id")
  ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "organization_memberships_org_user_unique" ON "organization_memberships" USING btree ("organization_id","user_id");
CREATE INDEX "organization_memberships_user_idx" ON "organization_memberships" USING btree ("user_id");
CREATE INDEX "organization_memberships_org_idx" ON "organization_memberships" USING btree ("organization_id");

INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status")
SELECT o."id", u."id", 'admin', 'active'
FROM "organizations" o
CROSS JOIN "app_users" u
WHERE o."slug" = 'orinlabs'
ON CONFLICT DO NOTHING;

CREATE TABLE "organization_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "organization_invites"
  ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_invites"
  ADD CONSTRAINT "organization_invites_created_by_user_id_app_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "organization_invites_token_hash_unique" ON "organization_invites" USING btree ("token_hash");
CREATE INDEX "organization_invites_org_idx" ON "organization_invites" USING btree ("organization_id");
CREATE INDEX "organization_invites_email_idx" ON "organization_invites" USING btree ("email");
CREATE INDEX "organization_invites_expires_idx" ON "organization_invites" USING btree ("expires_at");

ALTER TABLE "companies" ADD COLUMN "organization_id" uuid;
ALTER TABLE "mailboxes" ADD COLUMN "organization_id" uuid;
ALTER TABLE "outreach_events" ADD COLUMN "organization_id" uuid;
ALTER TABLE "outreach_drafts" ADD COLUMN "organization_id" uuid;
ALTER TABLE "campaigns" ADD COLUMN "organization_id" uuid;
ALTER TABLE "people" ADD COLUMN "organization_id" uuid;
ALTER TABLE "prospect_lists" ADD COLUMN "organization_id" uuid;
ALTER TABLE "campaign_runs" ADD COLUMN "organization_id" uuid;
ALTER TABLE "discovery_events" ADD COLUMN "organization_id" uuid;
ALTER TABLE "usage_events" ADD COLUMN "organization_id" uuid;
ALTER TABLE "app_sessions" ADD COLUMN "active_organization_id" uuid;

UPDATE "companies" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "mailboxes" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "outreach_events" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "outreach_drafts" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "campaigns" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "people" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "prospect_lists" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "campaign_runs" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "discovery_events" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "usage_events" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');
UPDATE "app_sessions" SET "active_organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'orinlabs');

ALTER TABLE "companies" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "mailboxes" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "outreach_events" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "outreach_drafts" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "campaigns" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "people" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "prospect_lists" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "campaign_runs" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "discovery_events" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "usage_events" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "people" ADD CONSTRAINT "people_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "prospect_lists" ADD CONSTRAINT "prospect_lists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "discovery_events" ADD CONSTRAINT "discovery_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;

DROP INDEX IF EXISTS "companies_domain_lower_unique";
DROP INDEX IF EXISTS "mailboxes_email_lower_unique";
DROP INDEX IF EXISTS "people_email_lower_unique";
DROP INDEX IF EXISTS "people_linkedin_url_unique";

CREATE UNIQUE INDEX "companies_domain_lower_unique" ON "companies" USING btree ("organization_id", lower(trim("domain"))) WHERE "domain" IS NOT NULL;
CREATE UNIQUE INDEX "mailboxes_email_lower_unique" ON "mailboxes" USING btree ("organization_id", lower("email"));
CREATE UNIQUE INDEX "people_email_lower_unique" ON "people" USING btree ("organization_id", lower(trim("email"))) WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX "people_linkedin_url_unique" ON "people" USING btree ("organization_id", "linkedin_url") WHERE "linkedin_url" IS NOT NULL;

CREATE INDEX "companies_organization_idx" ON "companies" USING btree ("organization_id");
CREATE INDEX "mailboxes_organization_idx" ON "mailboxes" USING btree ("organization_id");
CREATE INDEX "outreach_events_organization_idx" ON "outreach_events" USING btree ("organization_id");
CREATE INDEX "outreach_drafts_organization_idx" ON "outreach_drafts" USING btree ("organization_id");
CREATE INDEX "campaigns_organization_idx" ON "campaigns" USING btree ("organization_id");
CREATE INDEX "people_organization_idx" ON "people" USING btree ("organization_id");
CREATE INDEX "prospect_lists_organization_idx" ON "prospect_lists" USING btree ("organization_id");
CREATE INDEX "campaign_runs_organization_idx" ON "campaign_runs" USING btree ("organization_id");
CREATE INDEX "discovery_events_organization_idx" ON "discovery_events" USING btree ("organization_id");
CREATE INDEX "usage_events_organization_idx" ON "usage_events" USING btree ("organization_id");
CREATE INDEX "app_sessions_active_org_idx" ON "app_sessions" USING btree ("active_organization_id");
