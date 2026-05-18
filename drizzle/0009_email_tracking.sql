ALTER TABLE "outreach_drafts" ADD COLUMN "tracking_token" text;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "thread_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_drafts_tracking_token_unique" ON "outreach_drafts" USING btree ("tracking_token") WHERE "tracking_token" is not null;--> statement-breakpoint
CREATE TABLE "outreach_email_opens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_hash" text
);
--> statement-breakpoint
ALTER TABLE "outreach_email_opens" ADD CONSTRAINT "outreach_email_opens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_email_opens" ADD CONSTRAINT "outreach_email_opens_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_email_opens_draft_idx" ON "outreach_email_opens" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "outreach_email_opens_opened_idx" ON "outreach_email_opens" USING btree ("opened_at");--> statement-breakpoint
CREATE TABLE "outreach_thread_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_email" text,
	"to_email" text,
	"subject" text,
	"body_text" text,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_thread_messages" ADD CONSTRAINT "outreach_thread_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_thread_messages" ADD CONSTRAINT "outreach_thread_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_thread_messages" ADD CONSTRAINT "outreach_thread_messages_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_thread_messages_gmail_message_unique" ON "outreach_thread_messages" USING btree ("gmail_message_id");--> statement-breakpoint
CREATE INDEX "outreach_thread_messages_draft_idx" ON "outreach_thread_messages" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "outreach_thread_messages_company_idx" ON "outreach_thread_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "outreach_thread_messages_received_idx" ON "outreach_thread_messages" USING btree ("received_at");
